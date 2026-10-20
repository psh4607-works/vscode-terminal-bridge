const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Mailbox } = require('../dist/mailbox');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtb-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, box: new Mailbox(directory) };
}

test('listing an absent mailbox never creates directories', async t => {
  const { directory } = await fixture(t);
  const absent = path.join(directory, 'absent');
  const box = new Mailbox(absent);
  assert.deepEqual(await box.agents(), { agents: [], nextCursor: null });
  await assert.rejects(box.messages({ agentId: randomUUID() }), { code: 'AGENT_NOT_FOUND' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('existing agent and message lists do not mkdir or fsync', async t => {
  const { box } = await fixture(t);
  const from = randomUUID(), to = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'recipient');
  await box.send({ id: randomUUID(), from, to, text: 'read only' });
  const originalOpen = fs.open, originalMkdir = fs.mkdir;
  let syncs = 0, mkdirs = 0;
  fs.open = async function(...args) {
    const handle = await originalOpen.apply(this, args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { syncs++; return originalSync(); };
    return handle;
  };
  fs.mkdir = async function(...args) { mkdirs++; return originalMkdir.apply(this, args); };
  try {
    assert.equal((await box.agents()).agents.length, 2);
    assert.equal((await box.messages({ agentId: to })).messages.length, 1);
    assert.equal(syncs, 0, 'reads must not sync files or parent directories');
    assert.equal(mkdirs, 0, 'reads must not create directories');
  } finally { fs.open = originalOpen; fs.mkdir = originalMkdir; }
});

test('retry repairs interrupted inbox publication without changing the canonical message', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), other = randomUUID(), id = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'recipient'); await box.register(other, 'other');
  const input = { id, from, to, text: 'recover this delivery' };
  const inboxFile = path.join(directory, 'mailbox/messages', to, id + '.json');
  const originalLink = fs.link;
  fs.link = async function(source, destination) {
    if (destination === inboxFile) throw Object.assign(new Error('inbox disk failure'), { code: 'ENOSPC' });
    return originalLink.call(this, source, destination);
  };
  try { await assert.rejects(box.send(input), { code: 'ENOSPC' }); }
  finally { fs.link = originalLink; }
  const canonical = JSON.parse(await fs.readFile(path.join(directory, 'mailbox/requests', id + '.json'), 'utf8'));
  assert.deepEqual((await box.messages({ agentId: to })).messages, []);
  await assert.rejects(box.ack({ id, agentId: to }), { code: 'MESSAGE_NOT_DELIVERED' });
  await assert.rejects(box.send({ ...input, to: other }), { code: 'ID_CONFLICT' });
  assert.deepEqual((await box.messages({ agentId: other })).messages, []);
  const retried = await Promise.all(Array.from({ length: 4 }, () => new Mailbox(directory).send(input)));
  retried.forEach(message => assert.deepEqual(message, canonical));
  assert.deepEqual((await box.messages({ agentId: to })).messages.map(message => message.id), [id]);
});

test('equal timestamp messages paginate by exact ID order without skipping records', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'recipient');
  const ids = ['ffffffff-ffff-ffff-ffff-ffffffffffff', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001'];
  for (const id of ids) {
    const message = await box.send({ id, from, to, text: 'same timestamp' });
    const serialized = JSON.stringify({ ...message, createdAt: '2026-01-01T00:00:00.000Z' });
    await fs.writeFile(path.join(directory, 'mailbox/requests', id + '.json'), serialized);
    await fs.writeFile(path.join(directory, 'mailbox/messages', to, id + '.json'), serialized);
  }
  const seen = []; let cursor;
  do {
    const page = await box.messages({ agentId: to, cursor, limit: 1 });
    seen.push(...page.messages.map(message => message.id));
    cursor = page.nextCursor;
    assert.ok(seen.length <= ids.length, 'pagination must terminate');
  } while (cursor);
  assert.deepEqual(seen, [...ids].sort());
});

test('legacy flat messages fail explicitly and preserve the original bytes', async t => {
  const { directory, box } = await fixture(t);
  const from = randomUUID(), to = randomUUID(), id = randomUUID();
  await box.register(from, 'sender'); await box.register(to, 'recipient');
  const folder = path.join(directory, 'mailbox/messages');
  await fs.mkdir(folder, { mode: 0o700 });
  const filename = path.join(folder, id + '.json');
  const original = JSON.stringify({ id, from, to, text: 'old message', createdAt: '2026-01-01T00:00:00.000Z' }) + '\n';
  await fs.writeFile(filename, original, { mode: 0o600 });
  for (const operation of [
    () => box.messages({ agentId: to }),
    () => box.send({ id, from, to, text: 'old message' }),
    () => box.ack({ id, agentId: to }),
  ]) await assert.rejects(operation(), { code: 'MAILBOX_LAYOUT_UNSUPPORTED' });
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  assert.deepEqual(await fs.readdir(folder), [id + '.json']);
});
