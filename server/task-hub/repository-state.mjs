// Local Coding Agent - Task Hub Git repository identity/freshness inspection
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hashKey(prefix, value) {
  return createHash("sha256").update(`${prefix}:${value}`).digest("hex").slice(0, 32);
}

function assertBaseRef(value) {
  const ref = String(value || "origin/main").trim();
  if (!REF_RE.test(ref) || ref.startsWith("-") || ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new Error("base_ref contains unsupported Git ref syntax.");
  }
  return ref;
}

async function git(workspace, args, { allowExit1 = false } = {}) {
  try {
    const result = await execFileAsync("git", ["-C", workspace, ...args], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    });
    return { ok: true, stdout: String(result.stdout || "").trim(), exitCode: 0 };
  } catch (error) {
    if (allowExit1 && Number(error?.code) === 1) return { ok: false, stdout: String(error?.stdout || "").trim(), exitCode: 1 };
    return { ok: false, stdout: String(error?.stdout || "").trim(), exitCode: Number(error?.code) || -1, error };
  }
}

async function refreshRemoteBase(workspace, baseRef) {
  const slash = baseRef.indexOf("/");
  if (slash <= 0) return;
  const remote = baseRef.slice(0, slash);
  const branch = baseRef.slice(slash + 1);
  if (!REF_RE.test(remote) || !REF_RE.test(branch)) throw new Error("base_ref cannot be refreshed safely.");
  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  const fetched = await git(workspace, ["fetch", "--quiet", "--no-tags", remote, refspec]);
  if (!fetched.ok) throw new Error(`Could not refresh ${baseRef}; freshness cannot be proven.`);
}

export async function inspectGitRepository(workspaceRoot, { baseRef = "origin/main", refreshBase = false } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new Error("workspaceRoot is required.");
  const workspace = path.resolve(workspaceRoot);
  const workspaceKey = hashKey("workspace", canonicalPath(workspace));
  const ref = assertBaseRef(baseRef);

  const inside = await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return {
      is_git_repo: false,
      repository_key: hashKey("non-git-workspace", canonicalPath(workspace)),
      workspace_lock_key: workspaceKey,
      base_ref: ref,
      base_sha: null,
      head_sha: null,
      base_is_ancestor: null
    };
  }

  if (refreshBase) await refreshRemoteBase(workspace, ref);

  const common = await git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !common.stdout) throw new Error("Could not resolve Git common directory.");
  const commonDir = path.isAbsolute(common.stdout) ? common.stdout : path.resolve(workspace, common.stdout);
  const head = await git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const base = await git(workspace, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const headSha = head.ok && /^[0-9a-f]{40,64}$/i.test(head.stdout) ? head.stdout.toLowerCase() : null;
  const baseSha = base.ok && /^[0-9a-f]{40,64}$/i.test(base.stdout) ? base.stdout.toLowerCase() : null;
  let baseIsAncestor = null;
  if (headSha && baseSha) {
    const ancestor = await git(workspace, ["merge-base", "--is-ancestor", baseSha, headSha], { allowExit1: true });
    if (ancestor.ok) baseIsAncestor = true;
    else if (ancestor.exitCode === 1) baseIsAncestor = false;
  }

  return {
    is_git_repo: true,
    repository_key: hashKey("git-common-dir", canonicalPath(commonDir)),
    workspace_lock_key: workspaceKey,
    base_ref: ref,
    base_sha: baseSha,
    head_sha: headSha,
    base_is_ancestor: baseIsAncestor
  };
}
