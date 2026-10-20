const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const exec = promisify(execFile);
let Mailbox;
try { ({ Mailbox } = require('../dist/mailbox')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
async function fixture(t) {
  assert.equal(typeof Mailbox, 'function', 'durable mailbox must be available');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtb-mail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, box: new Mailbox(directory) };
}
test('registration is durable, explicitly identified, and retry-safe across instances', async t => {
  const { directory, box } = await fixture(t);
  const id = randomUUID();
  const agent = await box.register(id, 'reviewer');
  assert.deepEqual(await new Mailbox(directory).register(id, 'reviewer'), agent);
  assert.deepEqual((await new Mailbox(directory).agents()).agents, [agent]);
  await assert.rejects(box.register(id, 'another session'), { code: 'ID_CONFLICT' });
});
test('concurrent retries publish one durable message and reject changed payloads', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  const input = { id: messageId, from, to, text: 'Review this change' };
  assert.equal(typeof box.send, 'function', 'mailbox must support durable delivery');
  const replies = await Promise.all(Array.from({ length: 8 }, () => new Mailbox(directory).send(input)));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  const inbox = await new Mailbox(directory).messages({ agentId: to });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, messageId);
  assert.equal(inbox.messages[0].text, input.text);
  await assert.rejects(box.send({ ...input, text: 'changed' }), { code: 'ID_CONFLICT' });
  await assert.rejects(box.send({ ...input, id: randomUUID(), to: randomUUID() }), { code: 'AGENT_NOT_FOUND' });
  assert.equal((await box.messages({ agentId: from })).messages.length, 0);
});
test('read never consumes messages; explicit recipient ack survives restart and is idempotent', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  await box.send({ id: messageId, from, to, text: 'check me' });
  assert.equal((await box.messages({ agentId: to })).messages.length, 1);
  assert.equal((await box.messages({ agentId: to })).messages.length, 1);
  assert.equal(typeof box.ack, 'function', 'mailbox must support explicit receipt');
  await assert.rejects(box.ack({ id: messageId, agentId: from }), { code: 'WRONG_RECIPIENT' });
  const replies = await Promise.all(Array.from({ length: 6 }, () => new Mailbox(directory).ack({ id: messageId, agentId: to })));
  replies.forEach(reply => assert.deepEqual(reply, replies[0]));
  assert.equal((await new Mailbox(directory).messages({ agentId: to })).messages.length, 0);
  const all = await new Mailbox(directory).messages({ agentId: to, all: true });
  assert.equal(all.messages[0].acknowledgedAt, replies[0].acknowledgedAt);
});
test('record schema rejects coerced recipient IDs instead of silently dropping their messages', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  const sent = await box.send({ id: messageId, from, to, text: 'persist' });
  const filename = path.join(directory, 'mailbox/messages', messageId + '.json');
  await fs.writeFile(filename, JSON.stringify({ ...sent, to: [to] }));
  await assert.rejects(box.messages({ agentId: to }), { code: 'MAILBOX_CORRUPT' });
});
test('new mailbox directories sync their parent entries before returning success', async t => {
  const { directory, box } = await fixture(t);
  const original = fs.open;
  const synced = [];
  fs.open = async function(filename, ...args) {
    const handle = await original.call(this, filename, ...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { synced.push(filename); await sync(); };
    return handle;
  };
  try { await box.register(randomUUID(), 'durable'); } finally { fs.open = original; }
  assert.ok(synced.includes(directory), 'mailbox entry must be persisted in bridge directory');
  assert.ok(synced.includes(path.join(directory, 'mailbox')), 'agents entry must be persisted in mailbox directory');
});
test('independent processes safely race identical sends and acknowledgements', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  const input = { id: messageId, from, to, text: 'one durable record' };
  const child = `const {Mailbox}=require(process.argv[1]); const box=new Mailbox(process.argv[2]);
    box[process.argv[3]](JSON.parse(process.argv[4])).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.code);process.exitCode=1});`;
  for (const [method, payload] of [['send', input], ['ack', { id: messageId, agentId: to }]]) {
    const results = await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath,
      ['-e', child, path.resolve(__dirname, '../dist/mailbox.js'), directory, method, JSON.stringify(payload)])));
    results.forEach(result => assert.deepEqual(JSON.parse(result.stdout), JSON.parse(results[0].stdout)));
  }
  assert.equal((await box.messages({ agentId: to, all: true })).messages.length, 1);
  assert.equal((await box.messages({ agentId: to })).messages.length, 0);
});
test('accepted messages remain readable after the mailbox grows beyond 10000 records', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  await box.send({ id: randomUUID(), from, to, text: 'initial' });
  const folder = path.join(directory, 'mailbox/messages');
  for (let offset = 0; offset < 10000; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => {
      const id = `00000000-0000-0000-0000-${String(offset + i).padStart(12, '0')}`;
      return fs.writeFile(path.join(folder, id + '.json'), JSON.stringify({ id, from, to, text: 'old',
        createdAt: '2026-01-01T00:00:00.000Z' }), { mode: 0o600 });
    }));
  }
  const sent = await box.send({ id: randomUUID(), from, to, text: 'newly accepted' });
  const page = await box.messages({ agentId: to, cursor: '2026-02-01T00:00:00.000Z_00000000-0000-0000-0000-000000000000' });
  assert.ok(page.messages.some(message => message.id === sent.id));
});
test('private storage rejects symlinks, exposed permissions, corrupt JSON and unsafe IDs', async t => {
  const { directory, box } = await fixture(t);
  const agentId = randomUUID();
  await assert.rejects(box.register('../outside', 'bad'), { code: 'INVALID_PARAMS' });
  await box.register(agentId, 'safe');
  const record = path.join(directory, 'mailbox/agents', agentId + '.json');
  const original = await fs.readFile(record, 'utf8');
  await fs.chmod(record, 0o644);
  await assert.rejects(box.agents(), { code: 'UNSAFE_MAILBOX' });
  await fs.chmod(record, 0o600);
  await fs.writeFile(record, '{');
  await assert.rejects(box.agents(), { code: 'MAILBOX_CORRUPT' });
  await fs.unlink(record);
  const target = path.join(directory, 'outside.json');
  await fs.writeFile(target, original, { mode: 0o600 });
  await fs.symlink(target, record);
  await assert.rejects(box.agents(), { code: 'UNSAFE_MAILBOX' });
  assert.equal(await fs.readFile(target, 'utf8'), original);
  const other = path.join(directory, 'other');
  await fs.mkdir(other, { mode: 0o700 });
  await fs.symlink(path.join(directory, 'mailbox'), path.join(other, 'mailbox'));
  await assert.rejects(new Mailbox(other).agents(), { code: 'UNSAFE_MAILBOX' });
});
test('failed publication is not reported as delivery and orphan temp files are ignored', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'receiver');
  const input = { id: randomUUID(), from, to, text: 'retry exactly' };
  const original = fs.link;
  fs.link = async () => { throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' }); };
  try { await assert.rejects(box.send(input), { code: 'ENOSPC' }); }
  finally { fs.link = original; }
  const folder = path.join(directory, 'mailbox/messages');
  assert.deepEqual(await fs.readdir(folder), []);
  await fs.writeFile(path.join(folder, '.interrupted.tmp'), '{', { mode: 0o600 });
  assert.deepEqual((await box.messages({ agentId: to })).messages, []);
  await box.send(input);
  assert.equal((await box.messages({ agentId: to })).messages[0].id, input.id);
});
