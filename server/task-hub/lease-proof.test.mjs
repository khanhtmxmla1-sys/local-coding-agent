import test from "node:test";
import assert from "node:assert/strict";
import { leaseProof } from "./lease-proof.mjs";

test("lease proof is deterministic and one-way", async () => {
  const first = await leaseProof("sample-lease-value");
  const second = await leaseProof("sample-lease-value");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, "sample-lease-value");
});
