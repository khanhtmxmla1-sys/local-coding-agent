// Local Coding Agent - Task Hub parallel overlap detection
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

const SEMANTIC_PREFIX_RE = /\b(api|route|schema|type|component|migration|config|state|contract|permission):([^\s,;]+)/gi;
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s`"'<>|]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_-]+)?)/g;

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalizePathToken(value) {
  let text = String(value || "").trim().replace(/^[`'"(\[]+|[`'"),.;\]]+$/g, "");
  if (!text) return "";
  text = text.replace(/\\/g, "/").replace(/\/+/g, "/");
  text = path.posix.normalize(text);
  if (text === ".") return "";
  while (text.startsWith("./")) text = text.slice(2);
  while (text.endsWith("/")) text = text.slice(0, -1);
  return text.toLowerCase();
}

function extractPaths(task) {
  const values = [];
  for (const item of task?.planned_paths || []) values.push(normalizePathToken(item));
  for (const item of task?.scope_in || []) {
    const pathText = String(item)
      .replace(/\b(?:api|route|schema|type|component|migration|config|state|contract|permission):[^\s,;]+/gi, " ")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;]+/gi, " ");
    for (const match of pathText.matchAll(PATH_RE)) values.push(normalizePathToken(match[0]));
  }
  return uniqueSorted(values);
}

function normalizeSemanticKey(value) {
  return String(value || "").trim().replace(/^[`'"(\[]+|[`'"),.;\]]+$/g, "").toLowerCase();
}

function extractSemanticKeys(task) {
  const values = [];
  for (const item of task?.semantic_keys || []) values.push(normalizeSemanticKey(item));
  const texts = [task?.goal, ...(task?.scope_in || []), ...(task?.acceptance_criteria || [])];
  for (const text of texts) {
    for (const match of String(text || "").matchAll(SEMANTIC_PREFIX_RE)) {
      values.push(normalizeSemanticKey(`${match[1]}:${match[2]}`));
    }
  }
  return uniqueSorted(values);
}

function pathsOverlap(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function detectTaskOverlap(left, right) {
  const leftPaths = extractPaths(left);
  const rightPaths = extractPaths(right);
  const pathMatches = [];
  for (const a of leftPaths) {
    for (const b of rightPaths) {
      if (pathsOverlap(a, b)) pathMatches.push(a.length <= b.length ? b : a);
    }
  }

  const leftSemantic = new Set(extractSemanticKeys(left));
  const semanticMatches = extractSemanticKeys(right).filter((key) => leftSemantic.has(key));
  const normalizedPathMatches = uniqueSorted(pathMatches);
  const normalizedSemanticMatches = uniqueSorted(semanticMatches);
  return {
    hard_conflict: normalizedPathMatches.length > 0,
    requires_revalidation: normalizedPathMatches.length > 0 || normalizedSemanticMatches.length > 0,
    path_matches: normalizedPathMatches,
    semantic_matches: normalizedSemanticMatches
  };
}

export function taskOverlapEvidence(left, right) {
  const overlap = detectTaskOverlap(left, right);
  return {
    task_id: right.id,
    task_status: right.status || null,
    hard_conflict: overlap.hard_conflict,
    requires_revalidation: overlap.requires_revalidation,
    path_matches: overlap.path_matches,
    semantic_matches: overlap.semantic_matches
  };
}
