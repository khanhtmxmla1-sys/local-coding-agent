import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectRegistry } from "./project-registry.mjs";

const NOW = Date.parse("2026-08-14T00:00:00.000Z");

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-project-registry-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-project-workspace-"));
  return { dir, workspace, registry: new ProjectRegistry({ dir, now: () => NOW }) };
}

test("project registry persists immutable project mappings", async () => {
  const h = await harness();
  try {
    const created = await h.registry.register({ id: "tohieuquiz", workspace_root: h.workspace, allowed_roles: ["CODING", "REVIEWER"] });
    assert.equal(created.id, "tohieuquiz");
    assert.equal(created.workspace_root, path.resolve(h.workspace));
    assert.deepEqual(created.allowed_roles, ["CODING", "REVIEWER"]);

    const reopened = new ProjectRegistry({ dir: h.dir, now: () => NOW + 1 });
    assert.deepEqual(await reopened.get("tohieuquiz"), created);
    assert.deepEqual(await reopened.list(), [created]);
    await assert.rejects(() => reopened.register({ id: "tohieuquiz", workspace_root: h.workspace }), /already exists/i);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
    await rm(h.workspace, { recursive: true, force: true });
  }
});

test("project registry rejects unsafe ids, relative roots, unknown roles, duplicates and unknown fields", async () => {
  const h = await harness();
  try {
    await assert.rejects(() => h.registry.register({ id: "../escape", workspace_root: h.workspace }), /id/i);
    await assert.rejects(() => h.registry.register({ id: "relative", workspace_root: "relative/path" }), /absolute/i);
    await assert.rejects(() => h.registry.register({ id: "bad-role", workspace_root: h.workspace, allowed_roles: ["DEPLOY"] }), /allowed_roles/i);
    await assert.rejects(() => h.registry.register({ id: "dupe-role", workspace_root: h.workspace, allowed_roles: ["CODING", "CODING"] }), /duplicate/i);
    await assert.rejects(() => h.registry.register({ id: "unknown-field", workspace_root: h.workspace, unexpected_field: true }), /unknown/i);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
    await rm(h.workspace, { recursive: true, force: true });
  }
});
