import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.resolve(here, '..', 'START_ALL_MCP.bat');

test('canonical QuizPro launcher routes ngrok through the hardened MCP reverse proxy', () => {
  assert.equal(fs.existsSync(launcherPath), true, 'START_ALL_MCP.bat must exist in the repo as the canonical launcher');
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  assert.match(launcher, /node scripts\\mcp-reverse-proxy\.cjs/i);
  assert.match(launcher, /set "WORKSPACE=C:\\quizpro"/i);
  assert.match(launcher, /^set "MCP_FILESYSTEM_ROOT=%WORKSPACE%"$/im);
  assert.match(launcher, /ngrok\.exe http 8000/i);
  assert.doesNotMatch(launcher, /ngrok\.exe http 8787/i);
  assert.doesNotMatch(launcher, /^\s*set\s+"?MCP_PROXY_REQUIRE_AUTH=0/im);
  assert.match(launcher, /^set "MCP_PROXY_REQUIRE_AUTH=1"$/im);
  assert.match(launcher, /127\.0\.0\.1:8787\/healthz/i);
  assert.match(launcher, /Test-NetConnection[^\r\n]*8000/i);
});
