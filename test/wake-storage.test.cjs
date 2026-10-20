const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Mailbox } = require('../dist/mailbox');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtb-wake-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const box = new Mailbox(directory), from = randomUUID(), agentId = randomUUID(), id = randomUUID();
  await box.register(from, 'sender'); await box.register(agentId, 'receiver');
  const message = await box.send({ id, from, to: agentId, text: 'handle once' });
  return { directory, box, message, from, input: { id, agentId, runId: randomUUID(), threadId: randomUUID(), windowId: randomUUID() } };
}
test('durable attempt survives restart as unknown, and same-owner retry never resets it or acknowledges', async t => {
  const { directory, box, input, message } = await fixture(t);
  assert.equal(typeof box.beginDelivery, 'function', 'durable wake attempt API must exist');
  assert.deepEqual(await box.getMessage(input), message);
  assert.equal((await box.delivery(input)).stage, 'queued');
  const attempt = await box.beginDelivery(input);
  assert.equal(attempt.stage, 'submission_unknown');
  assert.equal(attempt.runId, input.runId);
  assert.deepEqual(await new Mailbox(directory).delivery(input), attempt);
  assert.deepEqual(await new Mailbox(directory).beginDelivery(input), attempt);
  assert.equal((await box.messages({ agentId: input.agentId })).messages.length, 1);
});
test('turn stages are durable, immutable, owner-bound, and independent from explicit ack', async t => {
  const { directory, box, input } = await fixture(t);
  assert.equal(typeof box.markDeliveryStarted, 'function', 'turn lifecycle ledger must exist');
  const startedInput = { ...input, turnId: 'turn-1' };
  await assert.rejects(box.markDeliveryStarted(startedInput), { code: 'DELIVERY_NOT_STARTED' });
  await box.beginDelivery(input);
  await assert.rejects(box.markDeliveryCompleted({ ...startedInput, status: 'completed' }), { code: 'DELIVERY_NOT_STARTED' });
  await assert.rejects(box.markDeliveryStarted({ ...startedInput, runId: randomUUID() }), { code: 'DELIVERY_CONFLICT' });
  const started = await box.markDeliveryStarted(startedInput);
  assert.equal(started.stage, 'turn_started');
  assert.deepEqual(await new Mailbox(directory).markDeliveryStarted(startedInput), started);
  await assert.rejects(box.markDeliveryStarted({ ...startedInput, turnId: 'other' }), { code: 'DELIVERY_CONFLICT' });
  await assert.rejects(box.markDeliveryCompleted({ ...startedInput, turnId: 'other', status: 'completed' }), { code: 'DELIVERY_CONFLICT' });
  const completed = await box.markDeliveryCompleted({ ...startedInput, status: 'completed' });
  assert.equal(completed.stage, 'turn_completed'); assert.equal(completed.status, 'completed');
  assert.deepEqual(await new Mailbox(directory).delivery(input), completed);
  assert.deepEqual(await box.markDeliveryStarted(startedInput), completed);
  assert.deepEqual(await box.markDeliveryCompleted({ ...startedInput, status: 'completed' }), completed);
  await assert.rejects(box.markDeliveryCompleted({ ...startedInput, status: 'failed' }), { code: 'DELIVERY_CONFLICT' });
  assert.equal((await box.messages({ agentId: input.agentId })).messages.length, 1);
  await box.ack(input);
  assert.deepEqual(await box.delivery(input), completed);
});
test('orphan stages cannot be adopted by beginning a later attempt', async t => {
  const { directory, box, input } = await fixture(t);
  const folder = path.join(directory, 'mailbox/delivery-started');
  await fs.mkdir(folder, { mode: 0o700 });
  await fs.writeFile(path.join(folder, input.id + '.json'), JSON.stringify({ id: input.id, agentId: input.agentId,
    runId: input.runId, turnId: 'orphan', startedAt: new Date().toISOString() }), { mode: 0o600 });
  await assert.rejects(box.beginDelivery(input), { code: 'MAILBOX_CORRUPT' });
  await assert.rejects(fs.stat(path.join(directory, 'mailbox/delivery-attempts', input.id + '.json')), { code: 'ENOENT' });
});
test('concurrent independent owners publish exactly one durable attempt', async t => {
  const { directory, box, input } = await fixture(t);
  const contenders = Array.from({ length: 8 }, () => ({ ...input, runId: randomUUID(), windowId: randomUUID() }));
  const results = await Promise.allSettled(contenders.map(value => new Mailbox(directory).beginDelivery(value)));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  results.filter(value => value.status === 'rejected').forEach(value => assert.equal(value.reason.code, 'DELIVERY_CONFLICT'));
  const winner = results.find(value => value.status === 'fulfilled').value;
  assert.deepEqual(await new Mailbox(directory).delivery(input), winner);
  await assert.rejects(box.beginDelivery({ ...winner, threadId: randomUUID() }), { code: 'DELIVERY_CONFLICT' });
  await assert.rejects(box.beginDelivery({ ...winner, windowId: randomUUID() }), { code: 'DELIVERY_CONFLICT' });
});
test('recipient authorization and canonical inbox validation precede every delivery mutation', async t => {
  const { directory, box, input, from } = await fixture(t);
  for (const method of ['delivery', 'getMessage', 'beginDelivery', 'markDeliveryStarted', 'markDeliveryCompleted']) {
    await assert.rejects(box[method]({ ...input, agentId: from, turnId: 'turn', status: 'completed' }), { code: 'WRONG_RECIPIENT' });
  }
  const inbox = path.join(directory, 'mailbox/messages', input.agentId, input.id + '.json');
  const record = JSON.parse(await fs.readFile(inbox, 'utf8'));
  await fs.writeFile(inbox, JSON.stringify({ ...record, text: 'tampered' }));
  await assert.rejects(box.beginDelivery(input), { code: 'MAILBOX_CORRUPT' });
  await fs.unlink(inbox);
  await assert.rejects(box.beginDelivery(input), { code: 'MESSAGE_NOT_DELIVERED' });
});
test('malformed ownership, turn identity, and stage schema fail closed', async t => {
  const { directory, box, input } = await fixture(t);
  for (const key of ['id', 'agentId', 'runId', 'threadId', 'windowId']) {
    await assert.rejects(box.beginDelivery({ ...input, [key]: '../unsafe' }), { code: 'INVALID_PARAMS' });
  }
  await box.beginDelivery(input);
  for (const turnId of ['', ' ', '\u001b[200~', null, ['turn']]) {
    await assert.rejects(box.markDeliveryStarted({ ...input, turnId }), { code: 'INVALID_PARAMS' });
  }
  await box.markDeliveryStarted({ ...input, turnId: 'turn' });
  await assert.rejects(box.markDeliveryCompleted({ ...input, turnId: 'turn', status: 'other' }), { code: 'INVALID_PARAMS' });
  const filename = path.join(directory, 'mailbox/delivery-started', input.id + '.json');
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const patch of [{ runId: randomUUID() }, { agentId: randomUUID() }, { startedAt: 'yesterday' }, { turnId: [] }, { id: randomUUID() }]) {
    await fs.writeFile(filename, JSON.stringify({ ...record, ...patch }));
    await assert.rejects(box.delivery(input), { code: 'MAILBOX_CORRUPT' });
  }
  await fs.writeFile(filename, '{');
  await assert.rejects(box.delivery(input), { code: 'MAILBOX_CORRUPT' });
});
test('ledger uses private regular files, rejects symlinks, and preserves unknown attempts on publication failure', async t => {
  const { directory, box, input } = await fixture(t);
  await box.beginDelivery(input);
  const filename = path.join(directory, 'mailbox/delivery-attempts', input.id + '.json');
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
  await fs.chmod(filename, 0o644);
  await assert.rejects(box.delivery(input), { code: 'UNSAFE_MAILBOX' });
  await fs.chmod(filename, 0o600);
  const original = fs.link;
  fs.link = async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(box.markDeliveryStarted({ ...input, turnId: 'turn' }), { code: 'ENOSPC' }); }
  finally { fs.link = original; }
  assert.equal((await box.delivery(input)).stage, 'submission_unknown');
  const target = path.join(directory, 'attempt.json');
  await fs.rename(filename, target); await fs.symlink(target, filename);
  await assert.rejects(box.delivery(input), { code: 'UNSAFE_MAILBOX' });
});
test('ledger schema rejects extra identity fields instead of letting them shadow attempt ownership', async t => {
  const { directory, box, input } = await fixture(t);
  await box.beginDelivery(input);
  await box.markDeliveryStarted({ ...input, turnId: 'turn' });
  const filename = path.join(directory, 'mailbox/delivery-started', input.id + '.json');
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  await fs.writeFile(filename, JSON.stringify({ ...record, threadId: randomUUID() }));
  await assert.rejects(box.delivery(input), { code: 'MAILBOX_CORRUPT' });
});
