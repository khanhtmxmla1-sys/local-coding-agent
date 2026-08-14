#!/usr/bin/env node
// Local Coding Agent
// MCP Migration Manager: build a secret-free connector inventory for moving
// MCP connections between ChatGPT accounts or other MCP clients.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_INVENTORY = join(REPO_ROOT, "mcp-inventory.local.json");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "mcp-migration-output");
const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|signature|sig)$/i;
const SECRET_FLAG_RE = /^--?(?:token|secret|password|passwd|api[-_]?key|authorization|credential|client[-_]?secret|access[-_]?token|refresh[-_]?token)$/i;

function writeStdout(value = "") {
  process.stdout.write(`${String(value)}\n`);
}

function writeStderr(value = "") {
  process.stderr.write(`${String(value)}\n`);
}

function safeId(value) {
  return String(value || "connector")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "connector";
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map((v) => String(v)))].sort();
}

function redactInline(value) {
  let text = String(value ?? "");
  text = text.replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>");
  text = text.replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "gh_<redacted>");
  text = text.replace(/sk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  text = text.replace(/(token|secret|password|passwd|api[-_]?key|authorization)=([^&\s]+)/gi, "$1=<redacted>");
  return text;
}

export function sanitizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return { url: "", sanitized: false, removed_query_keys: [] };
  try {
    const url = new URL(raw);
    let sanitized = false;
    const removed = [];
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      sanitized = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key)) {
        url.searchParams.delete(key);
        removed.push(key);
        sanitized = true;
      }
    }
    if (url.hash) {
      url.hash = "";
      sanitized = true;
    }
    return { url: url.toString(), sanitized, removed_query_keys: uniqueStrings(removed) };
  } catch {
    return { url: redactInline(raw), sanitized: redactInline(raw) !== raw, removed_query_keys: [], invalid: true };
  }
}

export function redactArgs(args = []) {
  const out = [];
  let redactNext = false;
  for (const raw of Array.isArray(args) ? args : []) {
    const arg = String(raw);
    if (redactNext) {
      out.push("<redacted>");
      redactNext = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && SECRET_FLAG_RE.test(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=<redacted>`);
      continue;
    }
    if (SECRET_FLAG_RE.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(redactInline(arg));
  }
  return out;
}

function normalizeAuth(auth = {}, inferredRefs = []) {
  const refs = [...inferredRefs];
  if (auth && typeof auth === "object") {
    if (auth.secret_env) refs.push(String(auth.secret_env));
    if (Array.isArray(auth.secret_refs)) refs.push(...auth.secret_refs.map(String));
    for (const key of Object.keys(auth)) {
      if (SECRET_KEY_RE.test(key) && key !== "secret_env" && key !== "secret_refs") refs.push(`field:${key}`);
    }
  }
  const type = String(auth?.type || (refs.length ? "configured" : "none")).toLowerCase();
  return {
    type,
    required: Boolean(auth?.required ?? (refs.length > 0)),
    ...(auth?.provider ? { provider: String(auth.provider) } : {}),
    secret_refs: uniqueStrings(refs)
  };
}

function normalizeConnector(input, index = 0, warnings = []) {
  if (!input || typeof input !== "object") throw new Error(`connector ${index + 1} must be an object`);
  const name = String(input.name || input.id || `Connector ${index + 1}`).trim();
  const id = safeId(input.id || name);
  const transport = String(input.transport || (input.command ? "stdio" : "http")).toLowerCase();
  if (!["http", "stdio"].includes(transport)) throw new Error(`${id}: unsupported transport ${transport}`);

  let endpoint = String(input.endpoint || "").trim();
  if (!endpoint && input.endpoint_env) endpoint = String(process.env[String(input.endpoint_env)] || "").trim();
  let healthUrl = String(input.health_url || "").trim();
  if (!healthUrl && input.health_url_env) healthUrl = String(process.env[String(input.health_url_env)] || "").trim();

  const endpointResult = sanitizeUrl(endpoint);
  const healthResult = sanitizeUrl(healthUrl);
  if (endpointResult.sanitized) warnings.push(`${id}: endpoint contained sensitive URL material and was sanitized`);
  if (healthResult.sanitized) warnings.push(`${id}: health_url contained sensitive URL material and was sanitized`);

  const envKeys = uniqueStrings(input.env_keys || []);
  const headerKeys = uniqueStrings(input.header_keys || []);
  const inferredRefs = [
    ...envKeys.filter((key) => SECRET_KEY_RE.test(key)),
    ...headerKeys.filter((key) => SECRET_KEY_RE.test(key) || key.toLowerCase() === "authorization")
      .map((key) => `header:${key}`)
  ];

  const connector = {
    id,
    name,
    transport,
    ...(endpointResult.url ? { endpoint: endpointResult.url } : {}),
    ...(input.endpoint_env ? { endpoint_env: String(input.endpoint_env) } : {}),
    ...(healthResult.url ? { health_url: healthResult.url } : {}),
    ...(input.command ? { command: redactInline(input.command) } : {}),
    ...(Array.isArray(input.args) ? { args: redactArgs(input.args) } : {}),
    ...(envKeys.length ? { env_keys: envKeys } : {}),
    ...(headerKeys.length ? { header_keys: headerKeys } : {}),
    auth: normalizeAuth(input.auth, inferredRefs),
    notes: (Array.isArray(input.notes) ? input.notes : input.notes ? [input.notes] : []).map((note) => redactInline(note))
  };

  if (transport === "http" && !connector.endpoint) warnings.push(`${id}: remote MCP endpoint is missing; set endpoint or endpoint_env before migration`);
  if (transport === "stdio" && !connector.command) warnings.push(`${id}: stdio command is missing`);
  return connector;
}

export function importMcpConfigObject(source, { sourceName = "config" } = {}) {
  const warnings = [];
  const connectors = [];
  if (!source || typeof source !== "object") throw new Error(`${sourceName}: expected JSON object`);

  if (Array.isArray(source.connectors)) {
    source.connectors.forEach((item, index) => connectors.push(normalizeConnector(item, index, warnings)));
    return { connectors, warnings };
  }

  const servers = source.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`${sourceName}: expected either connectors[] or mcpServers{}`);
  }

  let index = 0;
  for (const [name, raw] of Object.entries(servers)) {
    const server = raw && typeof raw === "object" ? raw : {};
    const envKeys = Object.keys(server.env && typeof server.env === "object" ? server.env : {});
    const headerKeys = Object.keys(server.headers && typeof server.headers === "object" ? server.headers : {});
    const secretRefs = [
      ...envKeys.filter((key) => SECRET_KEY_RE.test(key)),
      ...headerKeys.filter((key) => SECRET_KEY_RE.test(key) || key.toLowerCase() === "authorization")
        .map((key) => `header:${key}`)
    ];
    const endpoint = server.url || server.endpoint || server.httpUrl || "";
    const sanitized = sanitizeUrl(endpoint);
    if (sanitized.sanitized) warnings.push(`${safeId(name)}: secret URL fields from ${basename(sourceName)} were removed`);
    if (Object.values(server.env || {}).some((value) => String(value || "").length > 0)) {
      warnings.push(`${safeId(name)}: environment values from ${basename(sourceName)} were intentionally omitted`);
    }
    if (Object.values(server.headers || {}).some((value) => String(value || "").length > 0)) {
      warnings.push(`${safeId(name)}: header values from ${basename(sourceName)} were intentionally omitted`);
    }

    connectors.push(normalizeConnector({
      id: safeId(name),
      name,
      transport: endpoint ? "http" : "stdio",
      endpoint: sanitized.url,
      command: server.command,
      args: redactArgs(server.args || []),
      env_keys: envKeys,
      header_keys: headerKeys,
      auth: {
        type: secretRefs.some((ref) => ref.toLowerCase() === "header:authorization") ? "header" : (secretRefs.length ? "configured" : "none"),
        required: secretRefs.length > 0,
        secret_refs: secretRefs
      },
      notes: [`Imported from ${basename(sourceName)}; secret values were not copied.`]
    }, index++, warnings));
  }

  return { connectors, warnings };
}

function commandAvailable(command) {
  if (!command) return false;
  if (isAbsolute(command)) return existsSync(command);
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

async function probeHttp(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "local-coding-agent-mcp-migration-manager/1" },
      signal: controller.signal
    });
    const statusCode = response.status;
    if (statusCode >= 200 && statusCode < 400) return { status: "healthy", reachable: true, status_code: statusCode };
    if (statusCode === 401 || statusCode === 403) return { status: "auth_required", reachable: true, status_code: statusCode };
    if (statusCode >= 400 && statusCode < 500) return { status: "reachable", reachable: true, status_code: statusCode };
    return { status: "unhealthy", reachable: true, status_code: statusCode };
  } catch (error) {
    return { status: "unreachable", reachable: false, error: error?.name === "AbortError" ? "timeout" : String(error?.code || error?.message || "request_failed") };
  } finally {
    clearTimeout(timer);
  }
}

async function probeConnector(connector, timeoutMs) {
  if (connector.transport === "stdio") {
    const available = commandAvailable(connector.command);
    return { id: connector.id, name: connector.name, transport: "stdio", status: available ? "healthy" : "unavailable", command_available: available };
  }
  const probeUrl = connector.health_url || connector.endpoint;
  if (!probeUrl) return { id: connector.id, name: connector.name, transport: "http", status: "needs_input", reachable: false };
  const result = await probeHttp(probeUrl, timeoutMs);
  return { id: connector.id, name: connector.name, transport: "http", checked_url: sanitizeUrl(probeUrl).url, ...result };
}

function assertUniqueConnectors(connectors) {
  const seen = new Set();
  for (const connector of connectors) {
    if (seen.has(connector.id)) throw new Error(`duplicate connector id: ${connector.id}`);
    seen.add(connector.id);
  }
}

function renderChecklist(manifest, health) {
  const healthById = new Map(health.connectors.map((item) => [item.id, item]));
  const lines = [
    "# MCP Migration Checklist",
    "",
    `Generated: ${manifest.generated_at}`,
    "",
    "## Tài khoản ChatGPT mới",
    "",
    "1. Mở phần Apps / Developer Mode của tài khoản ChatGPT mới.",
    "2. Tạo lại từng custom MCP connector theo danh sách bên dưới.",
    "3. Với OAuth: đăng nhập/authorize lại bằng tài khoản mới.",
    "4. Với Bearer/API key: lấy secret từ secret manager hoặc biến môi trường; không copy secret vào manifest này.",
    "5. Scan tools, kiểm tra tên tool, rồi test một lệnh read-only trước khi bật quyền write.",
    "",
    "## Connectors",
    ""
  ];

  for (const connector of manifest.connectors) {
    const h = healthById.get(connector.id) || { status: "not_checked" };
    lines.push(`### ${connector.name}`);
    lines.push("");
    lines.push(`- ID: \`${connector.id}\``);
    lines.push(`- Transport: \`${connector.transport}\``);
    if (connector.endpoint) lines.push(`- Endpoint: \`${connector.endpoint}\``);
    if (!connector.endpoint && connector.endpoint_env) lines.push(`- Endpoint env: \`${connector.endpoint_env}\``);
    if (connector.command) lines.push(`- Command: \`${connector.command}\``);
    lines.push(`- Auth: ${connector.auth.type === "oauth" ? "OAuth" : `\`${connector.auth.type}\``}${connector.auth.required ? " (required)" : ""}`);
    if (connector.auth.provider) lines.push(`- OAuth provider: ${connector.auth.provider}`);
    if (connector.auth.secret_refs.length) lines.push(`- Secret refs: ${connector.auth.secret_refs.map((ref) => `\`${ref}\``).join(", ")}`);
    lines.push(`- Health: \`${h.status}\`${h.status_code ? ` (HTTP ${h.status_code})` : ""}`);
    for (const note of connector.notes || []) lines.push(`- Note: ${note}`);
    lines.push("");
    lines.push("Migration steps:");
    lines.push("- [ ] Add connector to the new ChatGPT account.");
    if (connector.auth.type === "oauth") lines.push("- [ ] Complete OAuth authorization again on the new account.");
    if (connector.auth.secret_refs.length) lines.push("- [ ] Resolve secret refs locally; do not paste them into this checklist.");
    lines.push("- [ ] Scan tools / confirm expected capabilities.");
    lines.push("- [ ] Run one read-only smoke test.");
    lines.push("");
  }

  if (manifest.warnings.length) {
    lines.push("## Warnings", "");
    for (const warning of manifest.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function buildMigrationBundle({ inventory, imported = [], checkHealth = true, timeoutMs = 2500 } = {}) {
  const warnings = [];
  const connectors = [];

  if (inventory) {
    const parsed = importMcpConfigObject(inventory, { sourceName: "inventory" });
    connectors.push(...parsed.connectors);
    warnings.push(...parsed.warnings);
  }
  for (const item of imported || []) {
    const parsed = importMcpConfigObject(item.data ?? item, { sourceName: item.sourceName || "import" });
    connectors.push(...parsed.connectors);
    warnings.push(...parsed.warnings);
  }
  assertUniqueConnectors(connectors);
  connectors.sort((a, b) => a.id.localeCompare(b.id));

  const generatedAt = new Date().toISOString();
  const manifest = {
    schema: "local-coding-agent/mcp-migration-manifest",
    version: 1,
    generated_at: generatedAt,
    secret_policy: "Secret values are never exported; only variable/header reference names are retained.",
    connectors,
    warnings: uniqueStrings(warnings.map(redactInline))
  };

  const healthConnectors = checkHealth
    ? await Promise.all(connectors.map((connector) => probeConnector(connector, timeoutMs)))
    : connectors.map((connector) => ({ id: connector.id, name: connector.name, transport: connector.transport, status: "not_checked" }));
  const health = { generated_at: generatedAt, connectors: healthConnectors };
  const checklist = renderChecklist(manifest, health);
  return { manifest, health, checklist };
}

export function writeMigrationArtifacts(bundle, outDir = DEFAULT_OUT_DIR) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const paths = {
    manifest: join(dir, "mcp-migration-manifest.json"),
    health: join(dir, "mcp-migration-health.json"),
    checklist: join(dir, "mcp-migration-checklist.md")
  };
  writeFileSync(paths.manifest, JSON.stringify(bundle.manifest, null, 2) + "\n", "utf8");
  writeFileSync(paths.health, JSON.stringify(bundle.health, null, 2) + "\n", "utf8");
  writeFileSync(paths.checklist, bundle.checklist + "\n", "utf8");
  return paths;
}

function inventoryTemplate() {
  return {
    version: 1,
    connectors: [
      {
        id: "local-coding-agent",
        name: "Local Coding Agent",
        transport: "http",
        endpoint_env: "MCP_MIGRATION_LOCAL_CODING_ENDPOINT",
        health_url: "http://127.0.0.1:8787/healthz",
        auth: { type: "bearer", required: true, secret_env: "MCP_AUTH_TOKEN" },
        notes: ["Set MCP_MIGRATION_LOCAL_CODING_ENDPOINT to the remote /mcp URL before migration."]
      }
    ]
  };
}

function usage() {
  writeStdout(`MCP Migration Manager

Usage:
  node scripts/mcp-migration-manager.mjs init [--inventory <file>] [--force]
  node scripts/mcp-migration-manager.mjs audit --inventory <file> [--import <file> ...] [--out-dir <dir>] [--no-health] [--timeout <ms>]

Commands:
  init     Create a local inventory template. Secret values do not belong in this file.
  audit    Build a secret-free migration manifest, health report and Vietnamese checklist.

Defaults:
  inventory: ${DEFAULT_INVENTORY}
  out-dir:   ${DEFAULT_OUT_DIR}

Import format:
  - This manager's connectors[] inventory format, or
  - JSON with an mcpServers{} object (env/header values are discarded).
`);
}

function parseCli(argv) {
  const command = argv[0] || "help";
  const opts = { inventory: DEFAULT_INVENTORY, imports: [], outDir: DEFAULT_OUT_DIR, checkHealth: true, timeoutMs: 2500, force: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--inventory") opts.inventory = resolve(argv[++i]);
    else if (arg === "--import") opts.imports.push(resolve(argv[++i]));
    else if (arg === "--out-dir") opts.outDir = resolve(argv[++i]);
    else if (arg === "--no-health") opts.checkHealth = false;
    else if (arg === "--timeout") opts.timeoutMs = Math.max(250, Math.min(15000, Number(argv[++i]) || 2500));
    else if (arg === "--force") opts.force = true;
    else if (arg === "--help" || arg === "-h") return { command: "help", opts };
    else throw new Error(`unknown option: ${arg}`);
  }
  return { command, opts };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const { command, opts } = parseCli(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") return usage();

  if (command === "init") {
    if (existsSync(opts.inventory) && !opts.force) throw new Error(`inventory already exists: ${opts.inventory} (use --force to replace)`);
    mkdirSync(dirname(opts.inventory), { recursive: true });
    writeFileSync(opts.inventory, JSON.stringify(inventoryTemplate(), null, 2) + "\n", "utf8");
    writeStdout(`Created local MCP inventory: ${opts.inventory}`);
    writeStdout("Add connector metadata only. Keep token/key/password values in environment variables or a secret manager.");
    return;
  }

  if (command !== "audit") throw new Error(`unknown command: ${command}`);
  if (!existsSync(opts.inventory)) throw new Error(`inventory not found: ${opts.inventory}. Run 'init' first.`);
  const imported = opts.imports.map((path) => ({ data: readJson(path), sourceName: path }));
  const bundle = await buildMigrationBundle({ inventory: readJson(opts.inventory), imported, checkHealth: opts.checkHealth, timeoutMs: opts.timeoutMs });
  const paths = writeMigrationArtifacts(bundle, opts.outDir);
  const healthy = bundle.health.connectors.filter((item) => item.status === "healthy").length;
  const needsAttention = bundle.health.connectors.length - healthy;
  writeStdout(`MCP Migration Manager: ${bundle.manifest.connectors.length} connector(s)`);
  writeStdout(`Health: ${healthy} healthy, ${needsAttention} need attention/not checked`);
  writeStdout(`Manifest:  ${paths.manifest}`);
  writeStdout(`Health:    ${paths.health}`);
  writeStdout(`Checklist: ${paths.checklist}`);
  if (bundle.manifest.warnings.length) writeStdout(`Warnings: ${bundle.manifest.warnings.length} (see manifest/checklist)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    writeStderr(`ERROR: ${redactInline(error?.message || error)}`);
    process.exit(1);
  });
}
