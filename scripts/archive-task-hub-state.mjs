#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  archiveTaskHubState,
  quarantineTaskHubState,
  resolveTaskHubStatePaths,
  verifyTaskHubArchive,
} from "../server/task-hub-archive.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function latestArchive(backupRoot) {
  const entries = await readdir(backupRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (names.length === 0) throw new Error(`No Task Hub archive exists under ${backupRoot}`);
  return path.join(backupRoot, names[0]);
}

const mode = process.argv[2];
if (!["archive", "verify", "quarantine"].includes(mode)) {
  throw new Error("Usage: archive-task-hub-state.mjs <archive|verify|quarantine> [--archive-dir PATH] [--runtime-stopped]");
}

const paths = resolveTaskHubStatePaths();
let result;
if (mode === "archive") {
  result = await archiveTaskHubState({
    ...paths,
    runtimeVersion: "5.0.0",
  });
} else {
  const archiveDir = path.resolve(
    argument("--archive-dir") || await latestArchive(paths.backupRoot),
  );
  result = mode === "verify"
    ? await verifyTaskHubArchive({ archiveDir })
    : await quarantineTaskHubState({
        ...paths,
        archiveDir,
        runtimeStopped: process.argv.includes("--runtime-stopped"),
      });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
