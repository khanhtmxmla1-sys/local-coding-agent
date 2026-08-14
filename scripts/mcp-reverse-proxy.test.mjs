import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMcpProxy, redactLog, safeForwardHeaders, startChild, validateRouteProcess } = require('./mcp-reverse-proxy.cjs');

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
