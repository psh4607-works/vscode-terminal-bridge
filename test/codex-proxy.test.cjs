const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { CodexProxy } = require('../dist/codex-proxy');

test('native lifecycle responses require explicit idle before authorizing wake', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp('/tmp/vtp-idle-');
  const backend = createServer(), wss = new WebSocketServer({ server: backend });
  const backendPath = path.join(directory, 'b'), proxyPath = path.join(directory, 'p');
  let responseStatus, proxy, native;
  wss.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    socket.send(JSON.stringify({ id: request.id, result: { thread: { id: 'test-thread', status: responseStatus } } }));
  }));
  t.after(async () => {
    native?.terminate(); await proxy?.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => backend.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  backend.listen(backendPath); await once(backend, 'listening');
  proxy = await CodexProxy.start(backendPath, proxyPath);
  native = new WebSocket('ws+unix://' + proxyPath + ':/'); await once(native, 'open');
  let requestId = 0;
  for (const status of [{ type: 'notLoaded' }, { type: 'systemError' }, undefined, {}, { type: 'future-status' }, { type: 'active', activeFlags: [] }, { type: 'idle' }]) {
    await t.test('status ' + (status?.type ?? 'missing'), async () => {
      responseStatus = status;
      const response = once(native, 'message');
      native.send(JSON.stringify({ id: ++requestId, method: 'thread/resume', params: { threadId: 'test-thread' } }));
      await response;
      assert.equal(proxy.canWake('test-thread'), status?.type === 'idle');
    });
  }
});

async function relayFixture(t) {
  const directory = await fs.mkdtemp('/tmp/vtp-frame-');
  const server = createServer(), wss = new WebSocketServer({ server });
  const backendPath = path.join(directory, 'b'), proxyPath = path.join(directory, 'p');
  let proxy, native;
  t.after(async () => {
    native?.terminate(); await proxy?.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  server.listen(backendPath); await once(server, 'listening');
  proxy = await CodexProxy.start(backendPath, proxyPath);
  const connected = once(wss, 'connection');
  native = new WebSocket('ws+unix://' + proxyPath + ':/'); await once(native, 'open');
  const [backend] = await connected;
  backend.on('error', () => {});
  return { proxy, native, backend };
}

test('native relay passes a 17 MiB plugin catalog response and remains usable', { timeout: 15000 }, async t => {
  const { native, backend, proxy } = await relayFixture(t);
  backend.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.method === 'plugin/list') backend.send(JSON.stringify({ id: request.id, result: { catalog: 'x'.repeat(17 * 1024 * 1024) } }));
    else backend.send(JSON.stringify({ id: request.id, result: { thread: { id: 'large-catalog-thread', status: { type: 'idle' } } } }));
  });
  const outcome = Promise.race([
    once(native, 'message').then(([bytes]) => ({ bytes })),
    once(native, 'close').then(() => ({ closed: true })),
  ]);
  native.send(JSON.stringify({ id: 1, method: 'plugin/list', params: {} }));
  const received = await outcome;
  assert.ok(received.bytes, 'legal native catalog frame must be forwarded, not disconnect the TUI');
  const reply = JSON.parse(received.bytes.toString());
  assert.equal(reply.id, 1); assert.equal(reply.result.catalog.length, 17 * 1024 * 1024);
  assert.equal(reply.result.catalog.at(-1), 'x');
  const resumed = once(native, 'message');
  native.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: 'large-catalog-thread' } }));
  await resumed;
  assert.equal(proxy.canWake('large-catalog-thread'), true);
});

async function bindIdle({ native, backend, proxy }) {
  backend.once('message', bytes => {
    const request = JSON.parse(bytes.toString());
    backend.send(JSON.stringify({ id: request.id, result: { thread: { id: 'large-catalog-thread', status: { type: 'idle' } } } }));
  });
  const response = once(native, 'message');
  native.send(JSON.stringify({ id: 'bind-idle', method: 'thread/resume', params: { threadId: 'large-catalog-thread' } }));
  await response;
  assert.equal(proxy.canWake('large-catalog-thread'), true, 'fixture establishes a real idle binding');
}

test('relay rejects frames above the native 128 MiB bound without reading their body', { timeout: 5000 }, async t => {
  const fixture = await relayFixture(t);
  await bindIdle(fixture);
  const { native, backend, proxy } = fixture;
  const closed = once(native, 'close');
  // Unmasked server frame header advertises an oversized body; no 128 MiB allocation is needed.
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
  header.writeBigUInt64BE(BigInt(128 * 1024 * 1024 + 1), 2);
  backend._socket.write(header);
  await closed;
  assert.equal(proxy.canWake('large-catalog-thread'), false);
});


test('slow native consumers are disconnected when queued data plus the next frame exceeds 144 MiB', { timeout: 5000 }, async t => {
  const fixture = await relayFixture(t);
  await bindIdle(fixture);
  const { native, backend, proxy } = fixture;
  const payload = JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'large-catalog-thread', status: { type: 'idle' } } });
  const limit = 144 * 1024 * 1024;
  // Model a stalled kernel/user-space send queue without allocating 144 MiB. All frames
  // still traverse the real backend -> relay -> native sockets and forwarding logic.
  let buffered = limit - Buffer.byteLength(payload);
  Object.defineProperty(proxy.native, 'bufferedAmount', { configurable: true, get: () => buffered });
  const accepted = once(native, 'message');
  backend.send(payload);
  assert.equal((await accepted)[0].toString(), payload, 'the exact queue budget remains allowed');
  assert.equal(proxy.canWake('large-catalog-thread'), true);
  buffered += 1;
  const outcome = Promise.race([
    once(native, 'message').then(() => 'forwarded'),
    once(native, 'close').then(() => 'closed'),
  ]);
  backend.send(payload);
  assert.equal(await outcome, 'closed', 'one byte over the queue budget must disconnect the slow consumer');
  assert.equal(proxy.canWake('large-catalog-thread'), false, 'backpressure revokes the existing wake binding');
});
