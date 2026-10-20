const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const os = require('node:os');
const WebSocket = require('ws');
let CodexClient;
try { ({ CodexClient } = require('../dist/codex-client')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const executable = path.join(__dirname, 'codex-client-fixture.cjs');
test('owned app-server initializes and correlates concurrent responses without answering approval requests', async t => {
  assert.equal(typeof CodexClient, 'function', 'Codex client is implemented');
  await fs.chmod(executable, 0o700);
  const client = await CodexClient.start({ cwd: __dirname, executable });
  t.after(() => client.close());
  const endpoint = client.endpoint.slice('unix://'.length);
  assert.equal((await fs.stat(path.dirname(endpoint))).mode & 0o777, 0o700);
  assert.deepEqual(await Promise.all([client.request('echo', { delay: 20, n: 1 }), client.request('echo', { n: 2 })]), [{ delay: 20, n: 1 }, { n: 2 }]);
  await assert.rejects(client.request('fail', {}), error => error.code === -32001);
  const notification = once(client, 'notification'), approval = once(client, 'serverRequest');
  await client.request('approval', {});
  assert.equal((await notification)[0].method, 'turn/started');
  assert.equal((await approval)[0].id, 'approval-1');
  assert.deepEqual(await client.request('echo', { alive: true }), { alive: true });
  const pending = client.request('never', {});
  const rejected = assert.rejects(pending, { code: 'CODEX_DISCONNECTED' });
  await assert.rejects(client.request('disconnect', {}), { code: 'CODEX_DISCONNECTED' });
  await rejected;
  await client.close(); await client.close();
  assert.equal(client.closed, true);
  await assert.rejects(fs.stat(path.dirname(endpoint)), { code: 'ENOENT' });
});

test('client bounds pending and outbound requests and fails closed on invalid or oversized frames', async t => {
  for (const method of ['malformed', 'large']) await t.test(method, async t => {
    const client = await CodexClient.start({ cwd: __dirname, executable });
    t.after(() => client.close());
    await assert.rejects(client.request('echo', { text: 'x'.repeat(256 * 1024) }), { code: 'CODEX_REQUEST_TOO_LARGE' });
    const pending = Array.from({ length: 64 }, () => client.request('never', {}).catch(error => error.code));
    await assert.rejects(client.request('echo', {}), { code: 'CODEX_REQUEST_LIMIT' });
    await client.close();
    assert.deepEqual(await Promise.all(pending), Array(64).fill('CODEX_DISCONNECTED'));
    const another = await CodexClient.start({ cwd: __dirname, executable });
    t.after(() => another.close());
    await assert.rejects(another.request(method, {}), { code: method === 'malformed' ? 'CODEX_PROTOCOL_ERROR' : 'CODEX_DISCONNECTED' });
    assert.equal(another.closed, true);
  });
});

test('startup normalizes owned sockets, rejects symlinks, and kills an owned child that ignores TERM', async t => {
  for (const model of ['protected-socket', 'unsafe-socket', 'symlink', 'ignore-term']) await t.test(model, async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vtc-fixture-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    if (model === 'symlink') await assert.rejects(CodexClient.start({ cwd, executable, model }), { code: 'UNSAFE_CODEX_SOCKET' });
    else {
      const client = await CodexClient.start({ cwd, executable, model });
      t.after(() => client.close());
      const info = JSON.parse(await fs.readFile(path.join(cwd, 'fixture-info.json'), 'utf8'));
      assert.equal((await fs.stat(info.socketPath)).mode & 0o777, 0o600);
      await client.close();
    }
    const info = JSON.parse(await fs.readFile(path.join(cwd, 'fixture-info.json'), 'utf8'));
    assert.throws(() => process.kill(info.pid, 0), { code: 'ESRCH' });
    if (info.physicalPath) await assert.rejects(fs.lstat(info.physicalPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(info.socketPath)), { code: 'ENOENT' });
  });
});

test('native proxy gates wakes on correlated binding and native turns, and preserves approval replies', async t => {
  const client = await CodexClient.start({ cwd: __dirname, executable });
  t.after(() => client.close());
  assert.equal(typeof client.canWake, 'function');
  assert.equal(client.canWake('original'), false);
  const native = new WebSocket('ws+unix://' + client.endpoint.slice('unix://'.length) + ':/');
  t.after(() => native.terminate());
  await once(native, 'open');
  let nextId = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const listener = raw => { const message = JSON.parse(raw.toString()); if (message.id !== id) return; native.off('message', listener); message.error ? reject(message.error) : resolve(message.result); };
    native.on('message', listener); native.send(JSON.stringify({ id, method, params }));
  });
  await rpc('thread/resume', { threadId: 'original' });
  assert.equal(client.canWake('original'), true);
  await rpc('turn/start', { threadId: 'original', input: [] });
  assert.equal(client.canWake('original'), false);
  await rpc('complete', { threadId: 'original' });
  assert.equal(client.canWake('original'), true);
  const approvalFrame = once(native, 'message');
  await rpc('nativeApproval', { threadId: 'original' });
  assert.equal(JSON.parse((await approvalFrame)[0].toString()).id, 'native-approval');
  assert.equal(client.canWake('original'), false);
  const receipt = once(native, 'message');
  const answer = { id: 'native-approval', result: { decision: 'decline' } };
  native.send(JSON.stringify(answer));
  assert.deepEqual(JSON.parse((await receipt)[0].toString()), { method: 'approvalReceived', params: answer });
  const stale = rpc('thread/resume', { threadId: 'stale', delay: 30 });
  await rpc('thread/resume', { threadId: 'other' });
  assert.equal(client.canWake('other'), false, 'pending lifecycle never permits a wake');
  await stale;

  assert.equal(client.canWake('original'), false);
  assert.equal(client.canWake('other'), true);
  const second = new WebSocket('ws+unix://' + client.endpoint.slice('unix://'.length) + ':/');
  await once(second, 'close');
  assert.equal(client.canWake('other'), true, 'second native connection cannot replace active binding');
  await rpc('thread/unsubscribe', { threadId: 'other' });
  assert.equal(client.canWake('other'), false);
  native.close(); await once(native, 'close');
  assert.equal(client.canWake('original'), false);
});

test('invalid launch options never spawn a server', async () => {
  await assert.rejects(CodexClient.start({ cwd: '.', executable }), { code: 'INVALID_PARAMS' });
  await assert.rejects(CodexClient.start({ cwd: __dirname, executable: '/missing/codex' }), { code: 'CODEX_EXECUTABLE_NOT_FOUND' });
  await assert.rejects(CodexClient.start({ cwd: __dirname, executable: './relative' }), { code: 'INVALID_PARAMS' });
});

test('close is idempotent even when a closed listener calls close synchronously', async t => {
  const client = await CodexClient.start({ cwd: __dirname, executable });
  t.after(() => client.close());
  let listenerClose;
  client.on('closed', () => { listenerClose = client.close(); });
  const closing = client.close();
  assert.equal(client.closed, true);
  assert.equal(listenerClose, closing);
  await closing;
});
