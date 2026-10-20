const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { startServer } = require('../dist/transport');
const { Mailbox } = require('../dist/mailbox');
function cli(args) {
  return new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, '../dist/cli.js'), ...args], (error, stdout, stderr) => {
    try { resolve({ code: error?.code ?? 0, body: JSON.parse(stdout), stderr }); } catch (cause) { reject(new Error(stdout + stderr, { cause })); }
  }));
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtmc-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('managed start/status/stop preserve JSON RPC and explicit window selection', async t => {
  const directory = await fixture(t), requestId = randomUUID();
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); });
  for (const windowId of ['one', 'two']) servers.push(await startServer({ directory, metadata: { id: windowId, pid: process.pid, workspaceFolders: [] }, dispatch: async (method, params) => ({ windowId, method, params }) }));
  const start = ['agent', 'start', '--name', 'worker', '--cwd', __dirname, '--request-id', requestId, '--model', 'fixture-model'];
  assert.equal((await cli(['--directory', directory, ...start])).body.error.code, 'AMBIGUOUS_WINDOW');
  assert.deepEqual((await cli(['--directory', directory, '--window', 'two', ...start])).body,
    { windowId: 'two', method: 'agent.start', params: { requestId, name: 'worker', cwd: __dirname, model: 'fixture-model' } });
  for (const action of ['status', 'stop']) assert.deepEqual((await cli(['--directory', directory, '--window', 'one', 'agent', action, requestId])).body,
    { windowId: 'one', method: 'agent.' + action, params: { id: requestId } });
});
test('managed arguments are validated before discovering windows', async t => {
  const directory = await fixture(t), id = randomUUID();
  for (const args of [
    ['agent', 'start'], ['agent', 'start', '--name', 'worker', '--cwd', __dirname],
    ['agent', 'start', '--name', 'worker', '--request-id', id],
    ['agent', 'start', '--cwd', __dirname, '--request-id', id],
    ['agent', 'start', id, '--name', 'worker', '--cwd', __dirname, '--request-id', id],
    ['agent', 'start', '--name', 'worker', '--cwd', 'relative', '--request-id', id],
    ['agent', 'status', id, '--model', 'bad'], ['agent', 'stop'],
    ['message', 'delivery', id],
  ]) {
    const result = await cli(['--directory', directory, ...args]);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.body.error.code, 'INVALID_ARGUMENT', args.join(' '));
  }
});
test('delivery status reads the offline ledger without a live window', async t => {
  const directory = await fixture(t), box = new Mailbox(directory);
  const from = randomUUID(), to = randomUUID(), id = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'recipient');
  await box.send({ id, from, to, text: 'offline message' });
  const result = await cli(['--directory', directory, '--window', 'offline', 'message', 'delivery', id, '--agent', to]);
  assert.equal(result.code, 0, JSON.stringify(result.body));
  assert.deepEqual(result.body, await box.delivery({ id, agentId: to }));
});
