import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveTaskHubState,
  quarantineTaskHubState,
  resolveTaskHubStatePaths,
  verifyTaskHubArchive,
  workspaceIdForRoot,
} from "./task-hub-archive.mjs";

const fixedNow = () => new Date("2026-08-14T00:00:00.000Z");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-hub-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskDir = path.join(root, "active", "tasks");
  const projectsDir = path.join(root, "active", "projects");
  const backupRoot = path.join(root, "backups");
  const quarantineRoot = path.join(root, "quarantine");
  await mkdir(path.join(taskDir, "nested"), { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.json"), "{\"id\":\"task-1\"}\n");
  await writeFile(path.join(taskDir, "nested", "lease.json"), "{\"lease\":null}\n");
  await writeFile(path.join(projectsDir, "projects.json"), "{\"projects\":[]}\n");
  return { root, taskDir, projectsDir, backupRoot, quarantineRoot };
}

test("resolveTaskHubStatePaths uses deterministic workspace-scoped defaults", () => {
  const resolved = resolveTaskHubStatePaths(
    {
      LOCALAPPDATA: "C:\\State",
      AGENT_WORKSPACE: "C:\\QuizPro",
    },
    "win32",
  );

  assert.equal(resolved.workspaceId, /^[0-9a-f]{16}$/.test(resolved.workspaceId) ? resolved.workspaceId : "");
  assert.equal(resolved.privateStateDir, path.resolve("C:\\State", "LocalCodingAgent"));
  assert.equal(resolved.taskDir, path.join(resolved.privateStateDir, "task-hub", resolved.workspaceId));
  assert.equal(resolved.projectsDir, path.join(resolved.privateStateDir, "task-hub-projects"));
  assert.equal(resolved.backupRoot, path.join(resolved.privateStateDir, "backups", "task-hub"));
});

test("resolveTaskHubStatePaths uses the active permission profile working directory", () => {
  const resolved = resolveTaskHubStatePaths(
    {
      LOCALAPPDATA: "C:\\State",
      AGENT_WORKSPACE: "C:\\LegacyWorkspace",
      AGENT_PERMISSION_PROFILE_JSON: JSON.stringify({
        name: "active",
        working_directory: "C:\\ProfileWorkspace",
        roots: [{ path: "C:\\ProfileWorkspace", preset: "develop" }],
      }),
    },
    "win32",
  );

  assert.equal(resolved.workspaceRoot, path.resolve("C:\\ProfileWorkspace"));
  assert.equal(resolved.workspaceId, workspaceIdForRoot(resolved.workspaceRoot, "win32"));
  assert.equal(
    resolved.taskDir,
    path.join(resolved.privateStateDir, "task-hub", resolved.workspaceId),
  );
});

test("archive copies state and writes a verified sha256 manifest", async (t) => {
  const options = await fixture(t);
  const result = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    runtimeVersion: "5.0.0",
    now: fixedNow,
  });

  assert.equal(result.manifest.verified, true);
  assert.deepEqual(result.manifest.sources.map((entry) => entry.kind), ["tasks", "projects"]);
  assert.ok(result.manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert.equal(result.manifest.files.length, 3);
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, "utf8")), result.manifest);
  assert.equal((await verifyTaskHubArchive({ archiveDir: result.archiveDir })).verified, true);
});

test("archive rejects a destination file created while the source is copied", async (t) => {
  const options = await fixture(t);

  await assert.rejects(
    archiveTaskHubState({
      ...options,
      workspaceId: "0123456789abcdef",
      now: fixedNow,
      operations: {
        copyDirectory: async (source, destination, copyOptions) => {
          const { cp } = await import("node:fs/promises");
          await cp(source, destination, copyOptions);
          if (source === options.taskDir) {
            await writeFile(path.join(destination, "late.json"), "{\"late\":true}\n");
          }
        },
      },
    }),
    /file set|verification failed/i,
  );
});

test("archive records absent sources without failing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-hub-archive-absent-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await archiveTaskHubState({
    taskDir: path.join(root, "missing-tasks"),
    projectsDir: path.join(root, "missing-projects"),
    backupRoot: path.join(root, "backups"),
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });

  assert.equal(result.manifest.files.length, 0);
  assert.equal(result.manifest.sources.every((entry) => entry.status === "absent"), true);
  assert.equal(result.manifest.verified, true);
});

test("archive refuses a symlink or junction source", async (t) => {
  const options = await fixture(t);
  const linkedDir = path.join(options.root, "linked-tasks");

  try {
    await symlink(options.taskDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("creating a test junction requires unavailable Windows privileges");
      return;
    }
    throw error;
  }

  await assert.rejects(
    archiveTaskHubState({ ...options, taskDir: linkedDir, now: fixedNow }),
    /symbolic link|junction|reparse/i,
  );
});

test("quarantine refuses to run without a verified manifest", async (t) => {
  const options = await fixture(t);
  const archiveDir = path.join(options.backupRoot, "unverified");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    path.join(archiveDir, "manifest.json"),
    JSON.stringify({ version: 1, verified: false, files: [] }),
  );

  await assert.rejects(
    quarantineTaskHubState({ ...options, archiveDir, runtimeStopped: true, now: fixedNow }),
    /verified archive/i,
  );
});

test("verified archive quarantines active state without deleting the backup", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    runtimeVersion: "5.0.0",
    now: fixedNow,
  });
  const result = await quarantineTaskHubState({
    ...options,
    archiveDir: archived.archiveDir,
    runtimeStopped: true,
    now: () => new Date("2026-08-14T00:01:00.000Z"),
  });

  assert.deepEqual(result.moved.sort(), [path.resolve(options.projectsDir), path.resolve(options.taskDir)].sort());
  await assert.rejects(readFile(path.join(options.taskDir, "task.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(options.projectsDir, "projects.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(result.quarantineDir, "tasks", "task.json"), "utf8"), "{\"id\":\"task-1\"}\n");
  assert.equal(await readFile(path.join(result.quarantineDir, "projects", "projects.json"), "utf8"), "{\"projects\":[]}\n");
  assert.equal((await verifyTaskHubArchive({ archiveDir: archived.archiveDir })).verified, true);
  const quarantineManifest = JSON.parse(
    await readFile(path.join(result.quarantineDir, "quarantine-manifest.json"), "utf8"),
  );
  assert.equal(quarantineManifest.moved.length, 2);
});

test("quarantine requires an explicit stopped-runtime confirmation", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      now: fixedNow,
    }),
    /runtime.*stopped/i,
  );
  assert.equal(
    await readFile(path.join(options.taskDir, "task.json"), "utf8"),
    "{\"id\":\"task-1\"}\n",
  );
});

test("quarantine rolls back when state changes immediately before rename", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  let mutated = false;

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      runtimeStopped: true,
      now: fixedNow,
      operations: {
        movePath: async (source, destination) => {
          if (!mutated && source === options.taskDir) {
            mutated = true;
            await writeFile(path.join(source, "late.json"), "{\"late\":true}\n");
          }
          await rename(source, destination);
        },
      },
    }),
    /changed since archive/i,
  );
  assert.equal(
    await readFile(path.join(options.taskDir, "late.json"), "utf8"),
    "{\"late\":true}\n",
  );
});

test("quarantine rolls back all moves when the success manifest cannot be written", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      runtimeStopped: true,
      now: fixedNow,
      operations: {
        writeJson: async (target, value) => {
          if (path.basename(target) === "quarantine-manifest.json") {
            throw new Error("manifest write failed");
          }
          await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
        },
      },
    }),
    /manifest write failed/i,
  );
  assert.equal(
    await readFile(path.join(options.taskDir, "task.json"), "utf8"),
    "{\"id\":\"task-1\"}\n",
  );
  assert.equal(
    await readFile(path.join(options.projectsDir, "projects.json"), "utf8"),
    "{\"projects\":[]}\n",
  );
});

test("quarantine journals and surfaces a failed rollback", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  let taskMoved = false;

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      runtimeStopped: true,
      now: fixedNow,
      operations: {
        movePath: async (source, destination) => {
          if (source === options.taskDir) {
            taskMoved = true;
            await rename(source, destination);
            return;
          }
          if (source === options.projectsDir) throw new Error("projects move failed");
          if (taskMoved && destination === options.taskDir) throw new Error("task rollback failed");
          await rename(source, destination);
        },
      },
    }),
    /rollback failed/i,
  );

  const quarantineEntries = await readdir(options.quarantineRoot, { withFileTypes: true });
  const quarantineDir = path.join(
    options.quarantineRoot,
    quarantineEntries.find((entry) => entry.isDirectory()).name,
  );
  const journal = JSON.parse(
    await readFile(path.join(quarantineDir, "quarantine-recovery.json"), "utf8"),
  );
  assert.equal(journal.status, "rollback_failed");
  assert.match(journal.rollback_errors.join("\n"), /task rollback failed/i);
  assert.equal(journal.moves.find((entry) => entry.kind === "tasks").status, "rollback_failed");
});

test("archive verification rejects a tampered copied file", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  await writeFile(path.join(archived.archiveDir, "tasks", "task.json"), "tampered\n");

  await assert.rejects(
    verifyTaskHubArchive({ archiveDir: archived.archiveDir }),
    /verification failed/i,
  );
});


test("verification rejects a manifest that omits an archived file", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  const manifest = JSON.parse(await readFile(archived.manifestPath, "utf8"));
  manifest.files = manifest.files.filter((entry) => !entry.relative_path.endsWith("lease.json"));
  await writeFile(archived.manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyTaskHubArchive({ archiveDir: archived.archiveDir }),
    /file set|verification failed/i,
  );
});

test("quarantine rejects active state that appeared after an absent archive", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-hub-archive-late-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    taskDir: path.join(root, "active", "tasks"),
    projectsDir: path.join(root, "active", "projects"),
    backupRoot: path.join(root, "backups"),
    quarantineRoot: path.join(root, "quarantine"),
  };
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  await mkdir(options.taskDir, { recursive: true });
  await writeFile(path.join(options.taskDir, "late.json"), "{\"late\":true}\n");

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      runtimeStopped: true,
      now: fixedNow,
    }),
    /not backed up|changed since archive/i,
  );
  assert.equal(await readFile(path.join(options.taskDir, "late.json"), "utf8"), "{\"late\":true}\n");
});

test("quarantine rejects active state changed after archive", async (t) => {
  const options = await fixture(t);
  const archived = await archiveTaskHubState({
    ...options,
    workspaceId: "0123456789abcdef",
    now: fixedNow,
  });
  await writeFile(path.join(options.taskDir, "task.json"), "{\"id\":\"changed\"}\n");

  await assert.rejects(
    quarantineTaskHubState({
      ...options,
      archiveDir: archived.archiveDir,
      runtimeStopped: true,
      now: fixedNow,
    }),
    /changed since archive/i,
  );
  assert.equal(await readFile(path.join(options.taskDir, "task.json"), "utf8"), "{\"id\":\"changed\"}\n");
});
