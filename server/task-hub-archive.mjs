import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPermissionProfileSync } from "./permission-resolver.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME_VERSION = "5.0.0";
const MANIFEST_NAME = "manifest.json";
const SOURCE_KINDS = ["tasks", "projects"];

function currentDate(now) {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid archive timestamp.");
  return date;
}

function timestampSegment(now) {
  return currentDate(now).toISOString().replace(/[:.]/g, "-");
}

function canonicalWorkspaceRoot(value, platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspaceIdForRoot(workspaceRoot, platform = process.platform) {
  return createHash("sha256")
    .update(canonicalWorkspaceRoot(workspaceRoot, platform))
    .digest("hex")
    .slice(0, 16);
}

export function resolveTaskHubStatePaths(env = process.env, platform = process.platform) {
  const stateHome = env.LOCALAPPDATA || env.APPDATA || os.homedir();
  const privateStateDir = path.resolve(
    env.AGENT_PRIVATE_STATE_DIR ||
      (platform === "win32"
        ? path.join(stateHome, "LocalCodingAgent")
        : path.join(
            env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
            "local-coding-agent",
          )),
  );
  const defaultWorkspace = path.resolve(moduleDir, "..", "agent-workspace");
  const legacyWorkspace = path.resolve(env.AGENT_WORKSPACE || defaultWorkspace);
  const permissionProfile = loadPermissionProfileSync({
    primaryRoot: legacyWorkspace,
    mode: String(env.AGENT_MODE || "safe").toLowerCase() === "full" ? "full" : "safe",
    profileJson: env.AGENT_PERMISSION_PROFILE_JSON || "",
    profileFile: env.AGENT_PERMISSION_PROFILE_FILE || "",
    profileName: env.AGENT_PERMISSION_PROFILE_NAME || "",
  });
  const workspaceRoot = path.resolve(permissionProfile.working_directory);
  const workspaceId = workspaceIdForRoot(workspaceRoot, platform);

  return {
    privateStateDir,
    workspaceRoot,
    workspaceId,
    taskDir: path.resolve(
      env.AGENT_TASK_HUB_DIR || path.join(privateStateDir, "task-hub", workspaceId),
    ),
    projectsDir: path.resolve(
      env.AGENT_TASK_HUB_PROJECTS_DIR || path.join(privateStateDir, "task-hub-projects"),
    ),
    backupRoot: path.join(privateStateDir, "backups", "task-hub"),
    quarantineRoot: path.join(privateStateDir, "quarantine", "task-hub"),
  };
}

async function pathState(target) {
  try {
    const info = await lstat(target);
    return { exists: true, info };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, info: null };
    throw error;
  }
}

function rejectLink(info, target) {
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link, junction, or reparse-point source: ${target}`);
  }
}

async function assertSafeDirectory(target) {
  const state = await pathState(target);
  if (!state.exists) return false;
  rejectLink(state.info, target);
  if (!state.info.isDirectory()) throw new Error(`Expected a directory: ${target}`);
  await realpath(target);
  return true;
}

async function collectFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of entries) {
    const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
    const entryPath = path.join(root, entryRelative);
    const info = await lstat(entryPath);
    rejectLink(info, entryPath);
    if (info.isDirectory()) {
      files.push(...await collectFiles(root, entryRelative));
    } else if (info.isFile()) {
      files.push(entryRelative);
    } else {
      throw new Error(`Refusing unsupported filesystem entry: ${entryPath}`);
    }
  }

  return files;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function safeManifestRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error("Archive manifest contains an unsafe relative path.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    throw new Error("Archive manifest contains an unsafe relative path.");
  }
  return normalized;
}


function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function validatedManifestRecords(manifest) {
  if (manifest.sources.length !== SOURCE_KINDS.length) {
    throw new Error("Archive manifest must contain exactly the tasks and projects sources.");
  }

  const sources = new Map();
  for (const source of manifest.sources) {
    if (
      !SOURCE_KINDS.includes(source?.kind) ||
      sources.has(source.kind) ||
      !["copied", "absent"].includes(source?.status) ||
      typeof source?.original_path !== "string" ||
      !path.isAbsolute(source.original_path)
    ) {
      throw new Error("Archive manifest contains an invalid or duplicate source record.");
    }
    sources.set(source.kind, source);
  }
  if (SOURCE_KINDS.some((kind) => !sources.has(kind))) {
    throw new Error("Archive manifest must contain exactly the tasks and projects sources.");
  }

  const files = new Map(SOURCE_KINDS.map((kind) => [kind, []]));
  const seenPaths = new Set();
  for (const entry of manifest.files) {
    if (
      !SOURCE_KINDS.includes(entry?.source) ||
      !Number.isSafeInteger(entry?.bytes) ||
      entry.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(entry?.sha256 || "")
    ) {
      throw new Error("Archive manifest contains an invalid file record.");
    }
    const relativePath = safeManifestRelativePath(entry.relative_path);
    if (!relativePath.startsWith(`${entry.source}/`)) {
      throw new Error("Archive manifest source does not match its relative path.");
    }
    if (seenPaths.has(relativePath)) {
      throw new Error("Archive manifest contains a duplicate file record.");
    }
    seenPaths.add(relativePath);
    files.get(entry.source).push({
      ...entry,
      relative_path: relativePath,
      source_relative_path: relativePath.slice(entry.source.length + 1),
    });
  }

  return { sources, files };
}

async function verifyFileSnapshot(root, expectedEntries, failurePrefix) {
  const exists = await assertSafeDirectory(root);
  if (!exists) throw new Error(`${failurePrefix}: directory is missing.`);

  const actualFiles = (await collectFiles(root))
    .map((relativePath) => relativePath.replaceAll("\\", "/"))
    .sort();
  const expectedFiles = expectedEntries
    .map((entry) => entry.source_relative_path)
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${failurePrefix}: file set does not match the verified manifest.`);
  }

  for (const entry of expectedEntries) {
    const target = path.join(root, ...entry.source_relative_path.split("/"));
    const targetInfo = await lstat(target);
    rejectLink(targetInfo, target);
    if (!targetInfo.isFile() || targetInfo.size !== entry.bytes) {
      throw new Error(`${failurePrefix}: metadata differs for ${entry.source_relative_path}.`);
    }
    if (await sha256File(target) !== entry.sha256) {
      throw new Error(`${failurePrefix}: hash differs for ${entry.source_relative_path}.`);
    }
  }
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, target);
}

export async function archiveTaskHubState(options) {
  const {
    taskDir,
    projectsDir,
    backupRoot,
    workspaceId = "unknown",
    runtimeVersion = DEFAULT_RUNTIME_VERSION,
    now,
    operations = {},
  } = options;
  const copyDirectory = operations.copyDirectory || cp;
  if (!taskDir || !projectsDir || !backupRoot) {
    throw new Error("taskDir, projectsDir, and backupRoot are required.");
  }

  await mkdir(backupRoot, { recursive: true });
  const archiveDir = path.join(backupRoot, `${timestampSegment(now)}-${workspaceId}`);
  await mkdir(archiveDir);
  const manifest = {
    version: 1,
    kind: "local-coding-agent-task-hub-backup",
    created_at: currentDate(now).toISOString(),
    runtime_version: runtimeVersion,
    workspace_id: workspaceId,
    verified: false,
    sources: [],
    files: [],
  };

  for (const [kind, sourceDir] of [["tasks", taskDir], ["projects", projectsDir]]) {
    const exists = await assertSafeDirectory(sourceDir);
    if (!exists) {
      manifest.sources.push({ kind, original_path: path.resolve(sourceDir), status: "absent" });
      continue;
    }

    const destinationDir = path.join(archiveDir, kind);
    const sourceFiles = await collectFiles(sourceDir);
    const hashes = new Map();
    for (const relativePath of sourceFiles) {
      hashes.set(relativePath, await sha256File(path.join(sourceDir, relativePath)));
    }

    await copyDirectory(sourceDir, destinationDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    manifest.sources.push({ kind, original_path: path.resolve(sourceDir), status: "copied" });

    const copiedEntries = [];
    for (const relativePath of sourceFiles) {
      const destinationFile = path.join(destinationDir, relativePath);
      const destinationInfo = await lstat(destinationFile);
      rejectLink(destinationInfo, destinationFile);
      const destinationHash = await sha256File(destinationFile);
      const sourceHash = hashes.get(relativePath);
      if (destinationHash !== sourceHash) {
        throw new Error(`Archive verification failed for ${kind}/${relativePath}`);
      }
      const entry = {
        source: kind,
        relative_path: path.posix.join(kind, relativePath.replaceAll("\\", "/")),
        source_relative_path: relativePath.replaceAll("\\", "/"),
        bytes: destinationInfo.size,
        sha256: destinationHash,
      };
      copiedEntries.push(entry);
      manifest.files.push({
        source: entry.source,
        relative_path: entry.relative_path,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }
    await verifyFileSnapshot(
      destinationDir,
      copiedEntries,
      `Archive verification failed for ${kind}`,
    );
  }

  manifest.files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  manifest.verified = true;
  const manifestPath = path.join(archiveDir, MANIFEST_NAME);
  await writeJsonAtomic(manifestPath, manifest);
  return { archiveDir, manifestPath, manifest };
}

export async function verifyTaskHubArchive({ archiveDir }) {
  if (!archiveDir) throw new Error("archiveDir is required.");
  if (!await assertSafeDirectory(archiveDir)) {
    throw new Error("A verified archive directory is required.");
  }
  const manifestPath = path.join(archiveDir, MANIFEST_NAME);
  const manifestState = await pathState(manifestPath);
  if (!manifestState.exists) throw new Error("A verified archive manifest is required.");
  rejectLink(manifestState.info, manifestPath);
  if (!manifestState.info.isFile()) {
    throw new Error("A verified archive manifest is required.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest?.version !== 1 ||
    manifest?.kind !== "local-coding-agent-task-hub-backup" ||
    manifest?.verified !== true ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.sources)
  ) {
    throw new Error("A verified archive manifest is required.");
  }

  const records = validatedManifestRecords(manifest);
  for (const kind of SOURCE_KINDS) {
    const source = records.sources.get(kind);
    const expectedEntries = records.files.get(kind);
    const destinationDir = path.join(archiveDir, kind);
    if (source.status === "copied") {
      await verifyFileSnapshot(
        destinationDir,
        expectedEntries,
        `Archive verification failed for ${kind}`,
      );
    } else {
      if (expectedEntries.length > 0 || (await pathState(destinationDir)).exists) {
        throw new Error(
          `Archive verification failed for ${kind}: absent source has archived content.`,
        );
      }
    }
  }

  return { verified: true, manifestPath, manifest };
}

export async function quarantineTaskHubState(options) {
  const {
    taskDir,
    projectsDir,
    archiveDir,
    quarantineRoot,
    runtimeStopped = false,
    now,
    operations = {},
  } = options;
  if (!taskDir || !projectsDir || !archiveDir || !quarantineRoot) {
    throw new Error("taskDir, projectsDir, archiveDir, and quarantineRoot are required.");
  }
  if (runtimeStopped !== true) {
    throw new Error("Quarantine requires explicit confirmation that the runtime is stopped.");
  }
  const movePath = operations.movePath || rename;
  const writeJson = operations.writeJson || writeJsonAtomic;

  const { manifest } = await verifyTaskHubArchive({ archiveDir });
  const records = validatedManifestRecords(manifest);
  const expectedSources = new Map([
    ["tasks", canonicalPath(taskDir)],
    ["projects", canonicalPath(projectsDir)],
  ]);
  for (const kind of SOURCE_KINDS) {
    const source = records.sources.get(kind);
    if (canonicalPath(source.original_path) !== expectedSources.get(kind)) {
      throw new Error("Verified archive does not match the requested active Task Hub paths.");
    }
  }

  const activeSources = new Map();
  for (const [kind, sourceDir] of [["tasks", taskDir], ["projects", projectsDir]]) {
    const exists = await assertSafeDirectory(sourceDir);
    activeSources.set(kind, exists);
    const archivedSource = records.sources.get(kind);
    if (!exists) continue;
    if (archivedSource.status !== "copied") {
      throw new Error(
        `Active ${kind} state was not backed up; state changed since archive.`,
      );
    }
    await verifyFileSnapshot(
      sourceDir,
      records.files.get(kind),
      `Active ${kind} state changed since archive`,
    );
  }

  await mkdir(quarantineRoot, { recursive: true });
  const quarantineDir = path.join(
    quarantineRoot,
    `${timestampSegment(now)}-${manifest.workspace_id || "unknown"}`,
  );
  await mkdir(quarantineDir);
  const moved = [];
  const plannedMoves = SOURCE_KINDS
    .filter((kind) => activeSources.get(kind))
    .map((kind) => {
      const sourceDir = kind === "tasks" ? taskDir : projectsDir;
      return {
        kind,
        original_path: path.resolve(sourceDir),
        quarantine_path: path.join(quarantineDir, kind),
        status: "planned",
      };
    });
  const intentPath = path.join(quarantineDir, "quarantine-intent.json");
  await writeJson(intentPath, {
    version: 1,
    kind: "local-coding-agent-task-hub-quarantine-intent",
    created_at: currentDate(now).toISOString(),
    archive_path: path.resolve(archiveDir),
    status: "planned",
    moves: plannedMoves,
  });

  try {
    for (const entry of plannedMoves) {
      await movePath(entry.original_path, entry.quarantine_path);
      entry.status = "moved";
      moved.push(entry);
      await verifyFileSnapshot(
        entry.quarantine_path,
        records.files.get(entry.kind),
        `Quarantined ${entry.kind} state changed since archive`,
      );
    }

    await writeJson(path.join(quarantineDir, "quarantine-manifest.json"), {
      version: 1,
      kind: "local-coding-agent-task-hub-quarantine",
      created_at: currentDate(now).toISOString(),
      archive_path: path.resolve(archiveDir),
      runtime_stopped_confirmed: true,
      moved,
    });
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of [...moved].reverse()) {
      try {
        await movePath(entry.quarantine_path, entry.original_path);
        entry.status = "rolled_back";
      } catch (rollbackError) {
        entry.status = "rollback_failed";
        entry.rollback_error = rollbackError?.message || String(rollbackError);
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      const recoveryPath = path.join(quarantineDir, "quarantine-recovery.json");
      const recovery = {
        version: 1,
        kind: "local-coding-agent-task-hub-quarantine-recovery",
        created_at: currentDate(now).toISOString(),
        archive_path: path.resolve(archiveDir),
        status: "rollback_failed",
        original_error: error?.message || String(error),
        rollback_errors: rollbackFailures.map((failure) => failure?.message || String(failure)),
        moves: plannedMoves,
      };
      try {
        await writeJson(recoveryPath, recovery);
      } catch (journalError) {
        throw new AggregateError(
          [error, ...rollbackFailures, journalError],
          "Quarantine failed, rollback failed, and the recovery record could not be written.",
        );
      }
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Quarantine failed and rollback failed. Recovery record: ${recoveryPath}`,
      );
    }
    throw error;
  }

  return {
    quarantineDir,
    moved: moved.map((entry) => entry.original_path),
  };
}
