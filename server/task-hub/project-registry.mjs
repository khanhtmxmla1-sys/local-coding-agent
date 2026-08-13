// Local Coding Agent - AI Task Hub private project registry
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_ROLES = new Set(["CODING", "REVIEWER", "BROWSER"]);
const REGISTRY_LOCKS = new Map();
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10_000;
const INPUT_FIELDS = new Set(["id", "workspace_root", "allowed_roles"]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function assertProjectId(id) {
  if (typeof id !== "string" || !PROJECT_ID_RE.test(id)) throw new Error(`project id must match ${PROJECT_ID_RE}.`);
  return id;
}

function normalizeRoles(value) {
  const roles = value == null ? ["CODING", "REVIEWER"] : value;
  if (!Array.isArray(roles) || !roles.length || roles.length > 10) throw new Error("allowed_roles must be a non-empty array.");
  const normalized = roles.map((role) => String(role));
  if (new Set(normalized).size !== normalized.length) throw new Error("Duplicate allowed_roles are not allowed.");
  for (const role of normalized) if (!ALLOWED_ROLES.has(role)) throw new Error(`allowed_roles contains unsupported role: ${role}`);
  return normalized;
}

async function acquireFileLock(lockPath) {
  const started = Date.now();
  while (true) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }), "utf8");
      } catch (error) {
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8"));
          if (current?.token === token) await rm(lockPath, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error("Project registry lock timed out.");
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withProcessLock(key, fn) {
  const previous = REGISTRY_LOCKS.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  REGISTRY_LOCKS.set(key, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (REGISTRY_LOCKS.get(key) === tail) REGISTRY_LOCKS.delete(key);
  }
}

async function normalizeProjectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("project must be an object.");
  const unknown = Object.keys(input).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown project field(s): ${unknown.join(", ")}`);
  const id = assertProjectId(input.id);
  if (typeof input.workspace_root !== "string" || !input.workspace_root.trim()) throw new Error("workspace_root is required.");
  if (!path.isAbsolute(input.workspace_root)) throw new Error("workspace_root must be an absolute path.");
  const workspaceRoot = path.resolve(input.workspace_root);
  const info = await stat(workspaceRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("workspace_root must be an existing directory.");
  return { id, workspace_root: workspaceRoot, allowed_roles: normalizeRoles(input.allowed_roles) };
}

export class ProjectRegistry {
  constructor({ dir, now = Date.now } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new Error("ProjectRegistry dir is required.");
    if (typeof now !== "function") throw new Error("ProjectRegistry now must be a function.");
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, "projects.json");
    this.lockPath = path.join(this.dir, ".projects.lock");
    this.lockKey = process.platform === "win32" ? this.dir.toLowerCase() : this.dir;
    this.now = now;
  }

  async ensureDir() { await mkdir(this.dir, { recursive: true }); }

  async readUnlocked() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeUnlocked(projects) {
    await this.ensureDir();
    const temp = path.join(this.dir, `.projects.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(projects, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }

  async withWriteLock(fn) {
    await this.ensureDir();
    return withProcessLock(this.lockKey, async () => {
      const release = await acquireFileLock(this.lockPath);
      try { return await fn(); }
      finally { await release(); }
    });
  }

  async validate(input) {
    return clone(await normalizeProjectInput(input));
  }

  async register(input) {
    const normalized = await normalizeProjectInput(input);
    const timestamp = Number(this.now());
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("ProjectRegistry clock returned an invalid value.");

    return this.withWriteLock(async () => {
      const projects = await this.readUnlocked();
      if (projects.some((project) => project.id === normalized.id)) throw new Error(`Project ${normalized.id} already exists.`);
      const record = { ...normalized, created_at: timestamp, updated_at: timestamp };
      projects.push(record);
      projects.sort((a, b) => a.id.localeCompare(b.id));
      await this.writeUnlocked(projects);
      return clone(record);
    });
  }

  async get(id) {
    id = assertProjectId(id);
    const projects = await this.readUnlocked();
    const record = projects.find((project) => project.id === id);
    return record ? clone(record) : null;
  }

  async list() {
    return clone((await this.readUnlocked()).sort((a, b) => a.id.localeCompare(b.id)));
  }
}
