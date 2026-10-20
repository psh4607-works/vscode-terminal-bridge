const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { startServer } = require('../dist/transport.js');
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../dist/cli.js'), ...args]);
    let out = ''; let err = '';
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject);
    child.on('close', code => { try { resolve({ code, body: JSON.parse(out), err }); } catch (error) { reject(new Error(out + err, { cause: error })); } });
  });
}
test('agent list is available offline and ignores window selection for directory-wide mailboxes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtbm-'));
  try {
    const result = await cli(['--directory', directory, '--window', 'offline', 'agent', 'list']);
    assert.equal(result.code, 0, JSON.stringify(result.body));
    assert.deepEqual(result.body, { agents: [], nextCursor: null });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('agent register selects a live window and forwards retry-stable session identity', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtbm-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const servers = [];
  try {
    for (const windowId of ['one', 'two']) servers.push(await startServer({ directory, metadata: { id: windowId, pid: process.pid, workspaceFolders: [] }, dispatch: async (method, params) => ({ windowId, method, params }) }));
    const ambiguous = await cli(['--directory', directory, 'agent', 'register', 'terminal', '--name', 'worker', '--session', id]);
    assert.equal(ambiguous.body.error.code, 'AMBIGUOUS_WINDOW');
    const result = await cli(['--directory', directory, '--window', 'two', 'agent', 'register', 'terminal', '--name', 'worker', '--session', id]);
    assert.equal(result.code, 0, JSON.stringify(result.body));
    assert.deepEqual(result.body, { windowId: 'two', method: 'agent.register', params: { terminalId: 'terminal', id, name: 'worker' } });
    const generated = await cli(['--directory', directory, '--window', 'one', 'agent', 'register', 'terminal', '--name', 'worker']);
    assert.match(generated.body.params.id, /^[0-9a-f-]{36}$/);
    const listed = await cli(['--directory', directory, 'agent', 'list']);
    assert.equal(listed.code, 0);
  } finally { await Promise.all(servers.map(server => server.close())); await fs.rm(directory, { recursive: true, force: true }); }
});
test('mailbox command argument errors are structured before window discovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtbm-'));
  try {
    for (const args of [
      ['message', 'send', 'recipient', '--from', 'sender', '--text', 'hello'],
      ['message', 'list'], ['message', 'ack', 'message'],
      ['agent', 'register', 'terminal'], ['agent', 'list', '--limit', 'oops'],
      ['message', 'list', 'recipient', '--enter'], ['message', 'list', 'recipient', '--text', 'hello'],
      ['agent', 'register', 'terminal', '--name', 'worker', '--all'],
    ]) {
      const result = await cli(['--directory', directory, ...args]);
      assert.equal(result.code, 1, args.join(' '));
      assert.equal(result.body.error.code, 'INVALID_ARGUMENT', args.join(' '));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('offline CLI exchanges messages, preserves retries, paginates, and acknowledges explicitly', async () => {
  const { Mailbox } = require('../dist/mailbox.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtbm-'));
  const sender = randomUUID(), recipient = randomUUID(), first = randomUUID(), second = randomUUID();
  try {
    const mailbox = new Mailbox(directory);
    await mailbox.register(sender, 'sender'); await mailbox.register(recipient, 'recipient');
    const args = ['--directory', directory];
    const send = ['message', 'send', recipient, '--from', sender, '--text', 'hello', '--request-id', first];
    const sent = await cli([...args, ...send]);
    assert.equal(sent.code, 0, JSON.stringify(sent.body));
    assert.equal(sent.body.id, first);
    assert.deepEqual((await cli([...args, ...send])).body, sent.body);
    assert.equal((await cli([...args, 'message', 'send', recipient, '--from', sender, '--text', 'next', '--request-id', second])).code, 0);
    const page = await cli([...args, 'message', 'list', recipient, '--limit', '1']);
    assert.equal(page.code, 0); assert.equal(page.body.messages.length, 1); assert.equal(typeof page.body.nextCursor, 'string');
    const next = await cli([...args, 'message', 'list', recipient, '--cursor', page.body.nextCursor]);
    assert.equal(next.code, 0); assert.equal(next.body.messages.length, 1);
    assert.notEqual(next.body.messages[0].id, page.body.messages[0].id);
    const ack = await cli([...args, 'message', 'ack', first, '--agent', recipient]);
    assert.equal(ack.code, 0, JSON.stringify(ack.body));
    assert.deepEqual((await cli([...args, 'message', 'ack', first, '--agent', recipient])).body, ack.body);
    const unread = await cli([...args, 'message', 'list', recipient]);
    assert.deepEqual(unread.body.messages.map(message => message.id), [second]);
    const all = await cli([...args, 'message', 'list', recipient, '--all']);
    assert.equal(all.body.messages.length, 2);
    const agents = await cli([...args, 'agent', 'list', '--limit', '1']);
    assert.equal(agents.body.agents.length, 1);
    assert.equal((await cli([...args, 'agent', 'list', '--cursor', agents.body.nextCursor])).body.agents.length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
