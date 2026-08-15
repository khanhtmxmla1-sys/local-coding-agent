import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const { createMcpProxy, redactLog, safeForwardHeaders, startChild, validateRouteProcess, resolveCommandSpec, buildRoutes } = require('./mcp-reverse-proxy.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('proxy fails closed when auth is required but token is missing', () => {
  assert.throws(() => createMcpProxy({ requireAuth: true, authToken: '', routes: {}, secrets: {} }), /auth is required/i);
});

function openResponse(url, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  return child;
}

test('no-auth mode is an explicit opt-in and still strips sensitive forwarding headers', async () => {
  let upstreamAuthorization = null;
  let upstreamCookie = null;
  const upstream = http.createServer((req, res) => {
    upstreamAuthorization = req.headers.authorization || null;
    upstreamCookie = req.headers.cookie || null;
    res.end('no-auth-ok');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createMcpProxy({ requireAuth: false, authToken: '', lcaUrl: upstreamUrl, routes: {}, secrets: {} });
  const proxyUrl = await listen(proxy.server);

  try {
    const result = await request(`${proxyUrl}/mcp`, {
      headers: { Authorization: 'Bearer should-not-forward', Cookie: 'sid=should-not-forward' }
    });
    assert.equal(result.status, 200);
    assert.equal(result.text, 'no-auth-ok');
    assert.equal(upstreamAuthorization, null);
    assert.equal(upstreamCookie, null);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('public proxy rate limit rejects requests after the configured budget', async () => {
  const proxy = createMcpProxy({
    requireAuth: false,
    authToken: '',
    routes: {},
    secrets: {},
    rateLimitPerMinute: 2,
    rateWindowMs: 60_000
  });
  const proxyUrl = await listen(proxy.server);

  try {
    assert.equal((await request(`${proxyUrl}/missing-1`)).status, 404);
    assert.equal((await request(`${proxyUrl}/missing-2`)).status, 404);
    const limited = await request(`${proxyUrl}/missing-3`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  } finally {
    await close(proxy.server);
  }
});

test('SSE child concurrency is globally bounded before another child is spawned', async () => {
  let spawned = 0;
  const spawnFn = () => {
    spawned += 1;
    return fakeChild();
  };
  const routes = {
    '/memory/sse': { prefix: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }
  };
  const proxy = createMcpProxy({
    requireAuth: false,
    authToken: '',
    routes,
    secrets: {},
    spawnFn,
    maxSseConnections: 1,
    rateLimitPerMinute: 100
  });
  const proxyUrl = await listen(proxy.server);
  let first;
  let second;

  try {
    first = await openResponse(`${proxyUrl}/memory/sse`);
    assert.equal(first.res.statusCode, 200);
    second = await openResponse(`${proxyUrl}/memory/sse`);
    assert.equal(second.res.statusCode, 429);
    assert.equal(spawned, 1);
  } finally {
    if (second?.res) second.res.destroy();
    if (first?.res) first.res.destroy();
    await close(proxy.server);
  }
});

test('outer /mcp POST body limit rejects oversized chunked requests before LCA', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    req.resume();
    res.end('unexpected-upstream');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createMcpProxy({
    requireAuth: false,
    authToken: '',
    lcaUrl: upstreamUrl,
    routes: {},
    secrets: {},
    maxLcaBodyBytes: 32,
    rateLimitPerMinute: 100
  });
  const proxyUrl = await listen(proxy.server);

  try {
    const result = await request(`${proxyUrl}/mcp`, { method: 'POST', body: 'x'.repeat(128) });
    assert.equal(result.status, 413);
    assert.equal(upstreamRequests, 0);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('unauthenticated traffic cannot consume the bearer-mode rate budget', async () => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  const upstreamUrl = await listen(upstream);
  const proxy = createMcpProxy({
    requireAuth: true,
    authToken: 'valid-token',
    lcaUrl: upstreamUrl,
    routes: {},
    secrets: {},
    rateLimitPerMinute: 1
  });
  const proxyUrl = await listen(proxy.server);

  try {
    assert.equal((await request(`${proxyUrl}/mcp`)).status, 401);
    assert.equal((await request(`${proxyUrl}/mcp`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request(`${proxyUrl}/mcp`, { headers: { Authorization: 'Bearer valid-token' } })).status, 200);
    assert.equal((await request(`${proxyUrl}/mcp`, { headers: { Authorization: 'Bearer valid-token' } })).status, 429);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('global bearer gate rejects unauthenticated public requests and strips auth before LCA', async () => {
  let upstreamAuthorization = null;
  const upstream = http.createServer((req, res) => {
    upstreamAuthorization = req.headers.authorization || null;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('upstream-ok');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createMcpProxy({ authToken: 'unit-test-token', requireAuth: true, lcaUrl: upstreamUrl, routes: {}, secrets: {} });
  const proxyUrl = await listen(proxy.server);

  try {
    const noAuth = await request(`${proxyUrl}/mcp`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await request(`${proxyUrl}/mcp`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrongAuth.status, 401);

    const ok = await request(`${proxyUrl}/mcp`, { headers: { Authorization: 'Bearer unit-test-token' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, 'upstream-ok');
    assert.equal(upstreamAuthorization, null);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('browser origins are denied by default and only explicit origins get CORS headers', async () => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  const upstreamUrl = await listen(upstream);
  const proxy = createMcpProxy({ authToken: 'token', requireAuth: true, lcaUrl: upstreamUrl, routes: {}, secrets: {}, allowedOrigins: 'https://chat.example' });
  const proxyUrl = await listen(proxy.server);

  try {
    const denied = await request(`${proxyUrl}/mcp`, { headers: { Origin: 'https://evil.example', Authorization: 'Bearer token' } });
    assert.equal(denied.status, 403);

    const allowed = await request(`${proxyUrl}/mcp`, { headers: { Origin: 'https://chat.example', Authorization: 'Bearer token' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://chat.example');
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('logs and forwarded headers do not retain bearer/token material', () => {
  const redacted = redactLog('Authorization: Bearer super-secret token=abc123 api_key=xyz789');
  assert.equal(redacted.includes('super-secret'), false);
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('xyz789'), false);

  const headers = safeForwardHeaders({ authorization: 'Bearer secret', cookie: 'sid=x', host: 'public.example', 'content-type': 'application/json' });
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers['content-type'], 'application/json');
});

test('child process launch is allowlisted and never uses a shell', () => {
  const calls = [];
  const fakeChild = { stdin: {}, stdout: {}, stderr: {} };
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild;
  };
  const route = { prefix: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
  validateRouteProcess(route);
  startChild(route, { PATH: process.env.PATH }, spawnFn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  if (process.platform === 'win32') {
    assert.equal(calls[0].command, process.execPath);
    assert.match(calls[0].args[0], /npx-cli\.js$/i);
    assert.deepEqual(calls[0].args.slice(1), route.args);
  } else {
    assert.equal(calls[0].command, 'npx');
    assert.deepEqual(calls[0].args, route.args);
  }
  assert.throws(() => validateRouteProcess({ command: 'cmd.exe', args: ['/c', 'whoami'] }), /not allowlisted/i);
});
test('Windows GitNexus launch resolves to a Node CLI entrypoint without shell execution', () => {
  if (process.platform !== 'win32') return;
  const previous = process.env.GITNEXUS_CLI_JS;
  const fakeCli = `${process.cwd()}\\scripts\\mcp-reverse-proxy.test.mjs`;
  process.env.GITNEXUS_CLI_JS = fakeCli;
  try {
    const spec = resolveCommandSpec('gitnexus', ['mcp']);
    assert.equal(spec.file, process.execPath);
    assert.equal(spec.args[0], fakeCli);
    assert.deepEqual(spec.args.slice(1), ['mcp']);
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_CLI_JS;
    else process.env.GITNEXUS_CLI_JS = previous;
  }
});

test('Filesystem MCP route honors MCP_FILESYSTEM_ROOT instead of exposing the whole drive', () => {
  const previous = process.env.MCP_FILESYSTEM_ROOT;
  process.env.MCP_FILESYSTEM_ROOT = 'C:\\quizpro';
  try {
    const routes = buildRoutes({});
    assert.equal(routes['/filesystem/sse'].args.at(-1), 'C:\\quizpro');
  } finally {
    if (previous === undefined) delete process.env.MCP_FILESYSTEM_ROOT;
    else process.env.MCP_FILESYSTEM_ROOT = previous;
  }
});
