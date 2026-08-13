// Local Coding Agent - AI Task Hub durable store
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  TASK_STATUSES,
  assertTaskId,
  createTaskRecord,
  dependenciesSatisfied,
  hasHighImpactPermission
} from "./model.mjs";
import { leaseProof } from "./lease-proof.mjs";

const STORE_LOCKS = new Map();
const FILE_LOCK_RETRY_MS = 15;
const FILE_LOCK_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(lockPath) {
  const startedAt = Date.now();

  while (true) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, created_at: Date.now() }), "utf8");
      } catch (error) {
        await rm(lockPath, { force: true });
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

      if (Date.now() - startedAt >= FILE_LOCK_TIMEOUT_MS) {
        throw new Error("Task Hub store lock timed out.");
      }
      await sleep(FILE_LOCK_RETRY_MS);
    }
  }
}

async function withStoreLock(key, fn) {
  const previous = STORE_LOCKS.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  STORE_LOCKS.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (STORE_LOCKS.get(key) === tail) STORE_LOCKS.delete(key);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertWorkerId(workerId) {
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 200) {
    throw new Error("workerId must be a non-empty string up to 200 characters.");
  }
  return workerId.trim();
}

function assertLeaseDuration(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60 * 1000) {
    throw new Error("leaseMs must be an integer from 1000 to 3600000 milliseconds.");
  }
  return leaseMs;
}

export class TaskHubStore {
  constructor({ dir, now = Date.now, idFactory = randomUUID } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new Error("TaskHubStore dir is required.");
    if (typeof now !== "function") throw new Error("TaskHubStore now must be a function.");
    if (typeof idFactory !== "function") throw new Error("TaskHubStore idFactory must be a function.");
    this.dir = path.resolve(dir);
    this.tasksDir = path.join(this.dir, "tasks");
    this.lockPath = path.join(this.dir, ".task-hub.lock");
    this.lockKey = process.platform === "win32" ? this.dir.toLowerCase() : this.dir;
    this.now = now;
    this.idFactory = idFactory;
  }

  taskPath(taskId) {
    return path.join(this.tasksDir, `${assertTaskId(taskId)}.json`);
  }

  async ensureDir() {
    await mkdir(this.tasksDir, { recursive: true });
  }

  async readTaskUnlocked(taskId) {
    try {
      return JSON.parse(await readFile(this.taskPath(taskId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeTaskUnlocked(task) {
    await this.ensureDir();
    const target = this.taskPath(task.id);
    const temp = path.join(this.tasksDir, `.${task.id}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  async withWriteLock(fn) {
    await this.ensureDir();
    return withStoreLock(this.lockKey, async () => {
      const releaseFileLock = await acquireFileLock(this.lockPath);
      try {
        return await fn();
      } finally {
        await releaseFileLock();
      }
    });
  }

  async createTask(input) {
    return this.withWriteLock(async () => {
      const record = createTaskRecord(input, { now: this.now() });
      if (await this.readTaskUnlocked(record.id)) throw new Error(`Task ${record.id} already exists.`);
      for (const dependencyId of record.depends_on) {
        if (!(await this.readTaskUnlocked(dependencyId))) throw new Error(`Missing dependency ${dependencyId}: task not found.`);
      }
      await this.writeTaskUnlocked(record);
      return clone(record);
    });
  }

  async getTask(taskId) {
    const task = await this.readTaskUnlocked(taskId);
    return task ? clone(task) : null;
  }

  async listTasks() {
    await this.ensureDir();
    const names = (await readdir(this.tasksDir)).filter((name) => name.endsWith(".json")).sort();
    const tasks = [];
    for (const name of names) {
      const task = await this.readTaskUnlocked(name.slice(0, -5));
      if (task) tasks.push(task);
    }
    return clone(tasks);
  }

  async loadDependenciesUnlocked(task) {
    const byId = new Map();
    for (const dependencyId of task.depends_on || []) {
      const dependency = await this.readTaskUnlocked(dependencyId);
      if (dependency) byId.set(dependencyId, dependency);
    }
    return byId;
  }

  async claimTask(taskId, workerId, leaseMs) {
    workerId = assertWorkerId(workerId);
    leaseMs = assertLeaseDuration(leaseMs);
    return this.withWriteLock(async () => {
      const task = await this.readTaskUnlocked(taskId);
      if (!task) throw new Error(`Task ${taskId} not found.`);
      const now = Number(this.now());
      if (!Number.isFinite(now)) throw new Error("TaskHubStore clock returned an invalid value.");

      if (task.status === TASK_STATUSES.RUNNING) {
        const expiresAt = Number(task.lease_expires_at || 0);
        if (expiresAt > now) throw new Error(`Task ${taskId} has an active lease.`);
        if (hasHighImpactPermission(task)) {
          throw new Error(`Task ${taskId} has an expired high-impact lease and requires reconciliation before reclaim.`);
        }
      } else if (task.status !== TASK_STATUSES.READY) {
        throw new Error(`Task ${taskId} is not READY.`);
      }

      const dependencies = await this.loadDependenciesUnlocked(task);
      if (!dependenciesSatisfied(task, dependencies)) {
        throw new Error(`Task ${taskId} dependencies are not DONE.`);
      }

      const leaseId = String(this.idFactory());
      if (!leaseId || leaseId.length > 300) throw new Error("idFactory returned an invalid lease id.");
      task.status = TASK_STATUSES.RUNNING;
      task.lease_owner = workerId;
      task.lease_proof = await leaseProof(leaseId);
      task.lease_expires_at = now + leaseMs;
      task.updated_at = now;
      task.version = Number(task.version || 0) + 1;
      await this.writeTaskUnlocked(task);
      return { lease_id: leaseId, task: clone(task) };
    });
  }

  async heartbeatTask(taskId, workerId, leaseId, leaseMs) {
    workerId = assertWorkerId(workerId);
    leaseMs = assertLeaseDuration(leaseMs);
    if (typeof leaseId !== "string" || !leaseId) throw new Error("lease id is required.");
    return this.withWriteLock(async () => {
      const task = await this.readTaskUnlocked(taskId);
      if (!task) throw new Error(`Task ${taskId} not found.`);
      const now = Number(this.now());
      const active = task.status === TASK_STATUSES.RUNNING && Number(task.lease_expires_at || 0) > now;
      const proofMatches = task.lease_proof === await leaseProof(leaseId);
      if (!active || task.lease_owner !== workerId || !proofMatches) {
        throw new Error(`Lease for task ${taskId} is missing, expired, or does not match this worker.`);
      }
      task.lease_expires_at = now + leaseMs;
      task.updated_at = now;
      task.version = Number(task.version || 0) + 1;
      await this.writeTaskUnlocked(task);
      return clone(task);
    });
  }
}
