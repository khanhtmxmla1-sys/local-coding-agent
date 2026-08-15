const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_SECRETS_FILE = path.join(ROOT_DIR, '.mcp-proxy-secrets.json');
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LCA_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_SSE_CONNECTIONS = 32;
const ALLOWED_CHILD_COMMANDS = new Set(['npx', 'gitnexus', 'zalo-agent']);

function stdout(message) {
  process.stdout.write(`${message}\n`);
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function resolveCommandSpec(command, args) {
  if (process.platform === 'win32' && command === 'npx') {
    const npxCli = process.env.NPX_CLI_JS || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (!fs.existsSync(npxCli)) throw new Error('npx-cli.js was not found; set NPX_CLI_JS');
    return { file: process.execPath, args: [npxCli, ...args] };
  }
  if (process.platform === 'win32' && command === 'gitnexus') {
    const appData = process.env.APPDATA || '';
    const gitnexusCli = process.env.GITNEXUS_CLI_JS || path.join(appData, 'npm', 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js');
    if (!gitnexusCli || !fs.existsSync(gitnexusCli)) throw new Error('GitNexus CLI entrypoint was not found; set GITNEXUS_CLI_JS');
    return { file: process.execPath, args: [gitnexusCli, ...args] };
  }
  if (process.platform === 'win32' && command === 'zalo-agent' && process.env.ZALO_AGENT_EXECUTABLE) {
    return { file: process.env.ZALO_AGENT_EXECUTABLE, args };
  }
  return { file: command, args };
}

function validateRouteProcess(routeDef) {
  if (!routeDef || !ALLOWED_CHILD_COMMANDS.has(routeDef.command)) {
    throw new Error('MCP route command is not allowlisted');
  }
  if (!Array.isArray(routeDef.args) || routeDef.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('MCP route args must be a string array');
  }
}

function startChild(routeDef, childEnv, spawnFn = spawn) {
  validateRouteProcess(routeDef);
  const spec = resolveCommandSpec(routeDef.command, routeDef.args);
  return spawnFn(spec.file, spec.args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv
  });
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function boundedPositiveInteger(value, fallback, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function loadSecrets(filePath = process.env.MCP_PROXY_SECRETS_FILE || DEFAULT_SECRETS_FILE) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP proxy secrets file must contain a JSON object');
  }
  return parsed;
}

function valueFrom(envName, secretName, secrets) {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== '') return envValue;
  const value = secrets[secretName];
  return value === undefined || value === null ? '' : String(value);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function isAuthorized(req, authToken) {
  return constantTimeEqual(extractBearer(req), authToken);
}

function redactLog(input) {
  return String(input || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|secret|password|authorization|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/([?&](?:token|key|secret|api[_-]?key)=)[^&\s]+/gi, '$1<redacted>');
}

function safeForwardHeaders(headers) {
  const next = { ...headers };
  delete next.authorization;
  delete next['proxy-authorization'];
  delete next.cookie;
  delete next.host;
  return next;
}

function buildRoutes(secrets) {
  const cloudflareAccountId = valueFrom('CLOUDFLARE_ACCOUNT_ID', 'cloudflareAccountId', secrets);
  const filesystemRoot = process.env.MCP_FILESYSTEM_ROOT || process.env.AGENT_WORKSPACE || ROOT_DIR;
  const figmaApiKey = valueFrom('FIGMA_API_KEY', 'figmaApiKey', secrets);
  const stitchApiKey = valueFrom('STITCH_API_KEY', 'stitchApiKey', secrets);
  const stitchProjectId = valueFrom('GOOGLE_CLOUD_PROJECT', 'stitchProjectId', secrets);
  const notionApiKey = valueFrom('NOTION_API_KEY', 'notionApiKey', secrets);
  const sentryAccessToken = valueFrom('SENTRY_ACCESS_TOKEN', 'sentryAccessToken', secrets);
  const githubToken = valueFrom('GITHUB_PERSONAL_ACCESS_TOKEN', 'githubToken', secrets) || valueFrom('GITHUB_TOKEN', 'githubToken', secrets);
  const firecrawlApiKey = valueFrom('FIRECRAWL_API_KEY', 'firecrawlApiKey', secrets);

  const route = (prefix, command, args, options = {}) => ({ prefix, command, args, ...options });
  return {
    '/gitnexus/sse': route('gitnexus', 'gitnexus', ['mcp']),
    '/figma/sse': route('figma', 'npx', ['-y', 'figma-developer-mcp', '--figma-api-key', figmaApiKey, '--stdio'], { required: [['FIGMA_API_KEY', figmaApiKey]] }),
    '/stitch/sse': route('stitch', 'npx', ['-y', '@_davideast/stitch-mcp', 'proxy'], { env: { GOOGLE_CLOUD_PROJECT: stitchProjectId, STITCH_API_KEY: stitchApiKey }, required: [['STITCH_API_KEY', stitchApiKey]] }),
    '/notion/sse': route('notion', 'npx', ['-y', '@notionhq/notion-mcp-server'], { env: { NOTION_API_KEY: notionApiKey }, required: [['NOTION_API_KEY', notionApiKey]] }),
    '/playwright/sse': route('playwright', 'npx', ['-y', '@playwright/mcp']),
    '/cloudflare/sse': route('cloudflare', 'npx', ['-y', '@cloudflare/mcp-server-cloudflare', 'run', cloudflareAccountId], { env: { CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId }, required: [['CLOUDFLARE_ACCOUNT_ID', cloudflareAccountId]] }),
    '/memory/sse': route('memory', 'npx', ['-y', '@modelcontextprotocol/server-memory']),
    '/sentry/sse': route('sentry', 'npx', ['-y', '@sentry/mcp-server', `--access-token=${sentryAccessToken}`], { required: [['SENTRY_ACCESS_TOKEN', sentryAccessToken]] }),
    '/fetch/sse': route('fetch', 'npx', ['-y', 'mcp-server-fetch-typescript']),
    '/filesystem/sse': route('filesystem', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', filesystemRoot]),
    '/puppeteer/sse': route('puppeteer', 'npx', ['-y', '@modelcontextprotocol/server-puppeteer']),
    '/context7/sse': route('context7', 'npx', ['-y', '@upstash/context7-mcp']),
    '/thinking/sse': route('thinking', 'npx', ['-y', '@modelcontextprotocol/server-sequential-thinking']),
    '/sqlite/sse': route('sqlite', 'npx', ['-y', 'mcp-server-sqlite', '--db', 'C:\\quizpro\\quizpro.db']),
    '/gitlocal/sse': route('gitlocal', 'npx', ['-y', '@cyanheads/git-mcp-server']),
    '/github/sse': route('github', 'npx', ['-y', '@modelcontextprotocol/server-github'], { env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken, GITHUB_TOKEN: githubToken }, required: [['GITHUB_TOKEN', githubToken]] }),
    '/imagegen/sse': route('imagegen', 'npx', ['-y', '@pollinations/mcp']),
    '/exa/sse': route('exa', 'npx', ['-y', 'exa-mcp-server']),
    '/upstash/sse': route('upstash', 'npx', ['-y', '@upstash/mcp-server']),
    '/pdf/sse': route('pdf', 'npx', ['-y', 'mcp-server-pdf']),
    '/trivy/sse': route('trivy', 'npx', ['-y', '@aquasecurity/trivy-mcp']),
    '/zalo/sse': route('zalo', 'zalo-agent', ['mcp', 'start']),
    '/firecrawl/sse': route('firecrawl', 'npx', ['-y', 'firecrawl-mcp'], { env: { FIRECRAWL_API_KEY: firecrawlApiKey }, required: [['FIRECRAWL_API_KEY', firecrawlApiKey]] }),
    '/cypress/sse': route('cypress', 'npx', ['-y', 'cypress-mcp']),
    '/faker/sse': route('faker', 'npx', ['-y', '@faker-js/mcp']),
    '/w3c/sse': route('w3c', 'npx', ['-y', 'w3c-html-validator']),
    '/github-review/sse': route('github-review', 'npx', ['-y', '@modelcontextprotocol/server-github'], { env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken, GITHUB_TOKEN: githubToken }, required: [['GITHUB_TOKEN', githubToken]] }),
    '/marp/sse': route('marp', 'npx', ['-y', 'pptx-viewer-mcp']),
    '/education/sse': route('education', 'npx', ['-y', 'education-mcp'])
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readProxyBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        const error = new Error('request body too large');
        error.statusCode = 413;
        req.off('data', onData);
        req.resume();
        reject(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function createMcpProxy(options = {}) {
  const secrets = options.secrets || loadSecrets(options.secretsFile);
  const authToken = options.authToken !== undefined ? options.authToken : valueFrom('MCP_PROXY_AUTH_TOKEN', 'proxyAuthToken', secrets);
  const requireAuth = options.requireAuth !== undefined ? options.requireAuth : parseBool(process.env.MCP_PROXY_REQUIRE_AUTH, true);
  if (requireAuth && !authToken) {
    throw new Error('MCP proxy auth is required but no global auth token is configured');
  }

  const lcaUrl = options.lcaUrl || process.env.MCP_PROXY_LCA_URL || 'http://127.0.0.1:8787';
  const maxBodyBytes = boundedPositiveInteger(options.maxBodyBytes ?? process.env.MCP_PROXY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 'MCP proxy max body bytes', 1, 64 * 1024 * 1024);
  const maxLcaBodyBytes = boundedPositiveInteger(options.maxLcaBodyBytes ?? process.env.MCP_PROXY_MAX_LCA_BODY_BYTES, DEFAULT_MAX_LCA_BODY_BYTES, 'MCP proxy LCA body bytes', 1, 64 * 1024 * 1024);
  const rateLimitPerMinute = boundedPositiveInteger(options.rateLimitPerMinute ?? process.env.MCP_PROXY_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE, 'MCP proxy rate limit', 1, 100_000);
  const rateWindowMs = boundedPositiveInteger(options.rateWindowMs ?? process.env.MCP_PROXY_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS, 'MCP proxy rate window', 1_000, 3_600_000);
  const maxSseConnections = boundedPositiveInteger(options.maxSseConnections ?? process.env.MCP_PROXY_MAX_SSE_CONNECTIONS, DEFAULT_MAX_SSE_CONNECTIONS, 'MCP proxy max SSE connections', 1, 1_000);
  const allowedOrigins = new Set(String(options.allowedOrigins ?? process.env.MCP_PROXY_ALLOWED_ORIGINS ?? '').split(',').map((v) => v.trim()).filter(Boolean));
  const routes = options.routes || buildRoutes(secrets);
  const spawnFn = options.spawnFn || spawn;
  const sseClients = new Map();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let rateWindowStartedAt = now();
  let rateWindowCount = 0;

  function reject(res, status, message, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(message);
  }

  function consumeRateBudget() {
    const current = now();
    if (current - rateWindowStartedAt >= rateWindowMs) {
      rateWindowStartedAt = current;
      rateWindowCount = 0;
    }
    rateWindowCount += 1;
    if (rateWindowCount <= rateLimitPerMinute) return null;
    return Math.max(1, Math.ceil((rateWindowStartedAt + rateWindowMs - current) / 1000));
  }

  function applyCors(req, res) {
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    if (!allowedOrigins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return true;
  }

  function createSseBridge(req, res, routeDef) {
    const missing = (routeDef.required || []).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) return reject(res, 503, `MCP route is not configured: missing ${missing.join(', ')}`);
    if (sseClients.size >= maxSseConnections) {
      return reject(res, 429, 'Too Many SSE Connections', { 'Retry-After': '5' });
    }

    const connId = `${routeDef.prefix}-${crypto.randomBytes(24).toString('hex')}`;
    const childEnv = { ...process.env, ...(routeDef.env || {}) };
    let child;
    try {
      child = startChild(routeDef, childEnv, spawnFn);
    } catch (error) {
      stderr(`[Proxy] ${routeDef.prefix} spawn failed: ${redactLog(error.message)}`);
      return reject(res, 503, 'MCP child process unavailable');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    sseClients.set(connId, { res, child, prefix: routeDef.prefix, authenticated: true });
    res.write(`event: endpoint\ndata: /message?connectionId=${connId}\n\n`);
    child.on('error', (error) => {
      sseClients.delete(connId);
      stderr(`[Proxy] ${routeDef.prefix} process error: ${redactLog(error.message)}`);
      if (!res.writableEnded) res.end();
    });

    let stdoutBuffer = '';
    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('{') && line.endsWith('}')) {
          let lineToSend = line;
          try {
            const parsed = JSON.parse(line);
            if (parsed.result && parsed.result.toolResult) {
              const toolResult = parsed.result.toolResult;
              parsed.result.content = toolResult.content || [];
              if (toolResult.isError !== undefined) parsed.result.isError = toolResult.isError;
              delete parsed.result.toolResult;
              lineToSend = JSON.stringify(parsed);
            }
          } catch {}
          res.write(`event: message\ndata: ${lineToSend}\n\n`);
        } else {
          stdout(`[Proxy] ${routeDef.prefix} log: ${redactLog(line).slice(0, 240)}`);
        }
      }
    });
    child.stderr.on('data', (data) => stderr(`[Proxy] ${routeDef.prefix} stderr: ${redactLog(data.toString()).slice(0, 500)}`));
    child.on('close', () => {
      sseClients.delete(connId);
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => {
      if (sseClients.has(connId)) {
        sseClients.delete(connId);
        try { child.kill(); } catch {}
      }
    });
  }

  async function proxyToLca(req, res, targetPath) {
    const upstream = new URL(targetPath, lcaUrl);
    const headers = safeForwardHeaders(req.headers);
    let body = null;
    if (!['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())) {
      try {
        body = await readProxyBody(req, maxLcaBodyBytes);
      } catch (error) {
        return reject(res, error.statusCode || 400, error.statusCode === 413 ? 'Payload Too Large' : 'Invalid Request Body');
      }
      delete headers['transfer-encoding'];
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const proxyReq = http.request(upstream, { method: req.method, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => reject(res, 502, 'Bad Gateway: Local Coding Agent seems offline'));
    if (body === null) proxyReq.end();
    else proxyReq.end(body);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!applyCors(req, res)) return reject(res, 403, 'Origin not allowed');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();




    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;
    const connectionId = reqUrl.searchParams.get('connectionId') || '';
    const activeClient = connectionId ? sseClients.get(connectionId) : null;
    const bearerOk = !requireAuth || isAuthorized(req, authToken);
    const continuationOk = pathname === '/message' && activeClient && activeClient.authenticated;
    if (!bearerOk && !continuationOk) return reject(res, 401, 'Unauthorized');

    const retryAfter = consumeRateBudget();
    if (retryAfter !== null) return reject(res, 429, 'Too Many Requests', { 'Retry-After': String(retryAfter) });

    if (routes[pathname] && req.method === 'GET') return createSseBridge(req, res, routes[pathname]);
    if ((pathname === '/mcp' || pathname === '/') && (req.method === 'GET' || req.method === 'POST')) return proxyToLca(req, res, req.url);

    if (pathname === '/message' && req.method === 'POST') {
      if (activeClient && activeClient.authenticated) {
        try {
          const body = await readBody(req, maxBodyBytes);
          activeClient.child.stdin.write(body + '\n');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('OK');
        } catch (error) {
          if (!res.writableEnded) reject(res, error.statusCode || 500, error.statusCode === 413 ? 'Payload Too Large' : 'Failed to deliver message');
          return;
        }
      }
      return proxyToLca(req, res, req.url);
    }

    reject(res, 404, 'Not Found');
  });

  return { server, authToken, requireAuth, routes, sseClients };
}

function main() {
  const host = process.env.MCP_PROXY_HOST || '127.0.0.1';
  const port = Number(process.env.MCP_PROXY_PORT || 8000);
  const { server, requireAuth } = createMcpProxy();
  server.listen(port, host, () => {
    stdout(`[Proxy] MCP Reverse Proxy listening on http://${host}:${port}`);
    stdout(`[Proxy] Global auth gate: ${requireAuth ? 'ENABLED' : 'DISABLED'}`);
    if (!requireAuth) stdout('[Proxy] WARNING: No Auth mode is enabled; public exposure is protected only by non-auth hardening controls.');
    stdout('[Proxy] Credentials are loaded from environment/local secret store; values are never logged.');
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    stderr(`[Proxy] Startup failed: ${redactLog(error.message)}`);
    process.exitCode = 1;
  }
}

module.exports = { createMcpProxy, loadSecrets, buildRoutes, isAuthorized, redactLog, safeForwardHeaders, constantTimeEqual, startChild, validateRouteProcess, resolveCommandSpec };
