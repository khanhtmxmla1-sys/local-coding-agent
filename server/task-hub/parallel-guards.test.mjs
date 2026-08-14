import test from "node:test";
import assert from "node:assert/strict";

import { detectTaskOverlap } from "./parallel-guards.mjs";

function task(overrides = {}) {
  return {
    id: "task-a",
    goal: "Change bounded behavior",
    role: "CODING",
    planned_paths: [],
    semantic_keys: [],
    scope_in: [],
    ...overrides
  };
}

test("overlap detector treats same/ancestor planned paths as hard overlap", () => {
  const exact = detectTaskOverlap(
    task({ planned_paths: ["src/components/ResultCard.tsx"] }),
    task({ id: "task-b", planned_paths: ["src/components/ResultCard.tsx"] })
  );
  assert.equal(exact.hard_conflict, true);
  assert.deepEqual(exact.path_matches, ["src/components/resultcard.tsx"]);

  const ancestor = detectTaskOverlap(
    task({ planned_paths: ["src/results"] }),
    task({ id: "task-b", planned_paths: ["src/results/ResultCard.tsx"] })
  );
  assert.equal(ancestor.hard_conflict, true);
  assert.equal(ancestor.path_matches.length, 1);

  const canonical = detectTaskOverlap(
    task({ planned_paths: ["src/a/../shared.ts"] }),
    task({ id: "task-b", planned_paths: ["src/shared.ts"] })
  );
  assert.equal(canonical.hard_conflict, true);
  assert.deepEqual(canonical.path_matches, ["src/shared.ts"]);
});

test("overlap detector infers file paths from scope and semantic keys from structured literals", () => {
  const result = detectTaskOverlap(
    task({ scope_in: ["Update src/api/results.ts", "api:/api/results", "component:ResultCard", "docs https://example.invalid/api/results"] }),
    task({ id: "task-b", scope_in: ["Read src/api/results.ts", "api:/api/results", "docs https://example.invalid/api/results"] })
  );
  assert.equal(result.hard_conflict, true);
  assert.deepEqual(result.path_matches, ["src/api/results.ts"]);
  assert.ok(result.semantic_matches.includes("api:/api/results"));
});

test("semantic-only overlap is soft but requires integration revalidation", () => {
  const result = detectTaskOverlap(
    task({ planned_paths: ["src/teacher.ts"], semantic_keys: ["api:/api/results"] }),
    task({ id: "task-b", planned_paths: ["src/student.ts"], semantic_keys: ["api:/api/results"] })
  );
  assert.equal(result.hard_conflict, false);
  assert.equal(result.requires_revalidation, true);
  assert.deepEqual(result.semantic_matches, ["api:/api/results"]);
});
