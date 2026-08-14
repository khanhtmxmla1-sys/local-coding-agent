import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { inspectGitRepository } from "./repository-state.mjs";

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}

test("repository identity is shared by worktrees while workspace lock keys stay distinct", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-repo-state-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "feature");
  try {
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "Task Hub Test");
    await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "base");
    await git(repo, "worktree", "add", "-b", "feature", worktree, "main");

    const mainState = await inspectGitRepository(repo, { baseRef: "main" });
    const featureState = await inspectGitRepository(worktree, { baseRef: "main" });
    assert.equal(mainState.is_git_repo, true);
    assert.equal(mainState.repository_key, featureState.repository_key);
    assert.notEqual(mainState.workspace_lock_key, featureState.workspace_lock_key);
    assert.equal(featureState.base_is_ancestor, true);

    await writeFile(path.join(repo, "next.txt"), "next\n", "utf8");
    await git(repo, "add", "next.txt");
    await git(repo, "commit", "-m", "advance main");
    const staleFeature = await inspectGitRepository(worktree, { baseRef: "main" });
    assert.equal(staleFeature.base_is_ancestor, false);
    assert.notEqual(staleFeature.base_sha, featureState.base_sha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshBase detects origin/main advancing in another clone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-repo-remote-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const feature = path.join(root, "feature");
  const writer = path.join(root, "writer");
  try {
    await git(root, "init", "--bare", origin);
    await git(root, "clone", origin, repo);
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "Task Hub Test");
    await git(repo, "switch", "-c", "main");
    await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "base");
    await git(repo, "push", "-u", "origin", "main");
    await git(repo, "worktree", "add", "-b", "feature", feature, "main");

    const before = await inspectGitRepository(feature, { baseRef: "origin/main", refreshBase: false });
    assert.equal(before.base_is_ancestor, true);

    await git(root, "clone", "--branch", "main", origin, writer);
    await git(writer, "config", "user.email", "writer@example.invalid");
    await git(writer, "config", "user.name", "Task Hub Writer");
    await writeFile(path.join(writer, "next.txt"), "next\n", "utf8");
    await git(writer, "add", "next.txt");
    await git(writer, "commit", "-m", "advance remote main");
    await git(writer, "push", "origin", "main");

    const stale = await inspectGitRepository(feature, { baseRef: "origin/main", refreshBase: true });
    assert.equal(stale.base_is_ancestor, false);
    assert.notEqual(stale.base_sha, before.base_sha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
