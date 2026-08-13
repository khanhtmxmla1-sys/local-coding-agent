// One-way representation for persisted lease proof.
import { webcrypto } from "node:crypto";

export async function leaseProof(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", Buffer.from(String(value)));
  return Buffer.from(digest).toString("hex");
}
