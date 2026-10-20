const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Mailbox } = require('../dist/mailbox');
const { ManagedAgents } = require('../dist/managed-agents');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp('/tmp/vta-review-'), mailbox = new Mailbox(directory), clients = [];
  const manager = new ManagedAgents({ windowId: randomUUID(), directory, mailbox, cliPath: '/tmp/cli.js', intervalMs: 0,
    resolveNode:options.resolveNode ?? (async()=>'/verified/node'),createClient: async () => {
      const c = new EventEmitter(); clients.push(c); c.closed = false; c.endpoint = 'unix:///tmp/fake.sock';
      c.canWake = () => true; c.threadId = randomUUID(); c.calls = []; c.close = async () => { c.closed = true; c.emit('closed'); };
      c.request = async (method, params) => {
        c.calls.push({ method, params });
        if (method === 'thread/name/set') return {};
        if (method === 'thread/start' || method === 'thread/read') return { thread: { id: c.threadId, status: { type: 'idle' } } };
        if (method === 'turn/start') {
          const turn = { id: randomUUID(), status: 'inProgress' };
          c.emit('notification', { method: 'turn/started', params: { threadId: c.threadId, turn } });
          return { turn };
        }
        throw Error(method);
      };
      return c;
    }, createTerminal: () => ({ id: randomUUID(), dispose() {} }) });
  t.after(async () => { await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const input = () => ({ requestId: randomUUID(), name: 'review', cwd: directory });
  const start = async () => {
    const agent = await manager.start(input());
    for (let i = 0; i < 100 && manager.status(agent.id).state === 'starting'; i++) await tick();
    return { agent, client: clients.at(-1) };
  };
  const send = async agentId => {
    const from = randomUUID(); await mailbox.register(from, 'peer');
    return mailbox.send({ id: randomUUID(), from, to: agentId, text: 'work' });
  };
  return { manager, mailbox, clients, input, start, send };
}
test('concurrent launches reserve the eight-agent capacity before asynchronous preparation', async t => {
  const f = await setup(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => f.manager.start(f.input())));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 8);
  outcomes.filter(item => item.status === 'rejected').forEach(item => assert.equal(item.reason.code, 'AGENT_LIMIT'));
});
test('terminal closure during durable attempt publication keeps the terminal closed and never submits', async t => {
  const f = await setup(t), { agent, client } = await f.start();
  await f.send(agent.id);
  const entered = deferred(), release = deferred(), original = f.mailbox.beginDelivery.bind(f.mailbox);
  f.mailbox.beginDelivery = async value => { const result = await original(value); entered.resolve(); await release.promise; return result; };
  const polling = f.manager.poll(); await entered.promise;
  await f.manager.terminalClosed(f.manager.status(agent.id).terminalId);
  release.resolve(); await polling;
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(f.manager.status(agent.id).state, 'closed');
});
test('matching launch retries racing preparation create one binding', async t => {
  const f = await setup(t), input = f.input();
  const agents = await Promise.all(Array.from({ length: 10 }, () => f.manager.start(input)));
  assert.equal(new Set(agents.map(agent => agent.id)).size, 1);
  for (let i = 0; i < 100 && f.manager.status(agents[0].id).state === 'starting'; i++) await tick();
  assert.equal(f.clients.length, 1);
});
test('unchanged inbox polling avoids repeated full mailbox scans', async t => {
  const f = await setup(t); await f.start();
  let scans = 0; const original = f.mailbox.messages.bind(f.mailbox);
  f.mailbox.messages = async options => { scans++; return original(options); };
  await f.manager.poll(); await f.manager.poll(); await f.manager.poll();
  assert.equal(scans, 1);
});
test('completed notification before turn-start RPC reply is persisted after correlation', async t => {
  const f = await setup(t), { agent, client } = await f.start(), message = await f.send(agent.id);
  const original = client.request;
  client.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    const turn = { id: randomUUID(), status: 'completed' };
    client.emit('notification', { method: 'turn/completed', params: { threadId: client.threadId, turn } });
    client.emit('notification', { method: 'thread/status/changed', params: { threadId: client.threadId, status: { type: 'idle' } } });
    return { turn };
  };
  await f.manager.poll();
  assert.equal((await f.mailbox.delivery({ id: message.id, agentId: agent.id })).stage, 'turn_completed');
  assert.equal(f.manager.status(agent.id).state, 'idle');
});
test('launch request IDs reject coercible non-string values before deduplication', async t => {
  const f = await setup(t), input = f.input();
  await assert.rejects(f.manager.start({ ...input, requestId: [input.requestId] }), { code: 'INVALID_PARAMS' });
});
test('a failed preparation can be retried after correcting its environment', async t => {
  const f = await setup(t), input = f.input();
  input.cwd += '/later';
  await assert.rejects(f.manager.start(input), { code: 'ENOENT' });
  await fs.mkdir(input.cwd);
  const agent = await f.manager.start(input);
  assert.equal(agent.state, 'starting');
  assert.equal((await f.manager.start(input)).id, agent.id);
});

test('runtime validation rejects before registration and can retry the same request after correction', async t => {
  let failRuntime = true;
  const f = await setup(t, { resolveNode: async () => {
    if (failRuntime) throw Object.assign(Error('unavailable'), { code: 'NODE_EXECUTABLE_NOT_FOUND' });
    return '/verified/node';
  } });
  const input = f.input();
  await assert.rejects(f.manager.start(input), { code: 'NODE_EXECUTABLE_NOT_FOUND' });
  assert.equal(f.clients.length, 0);
  assert.equal((await f.mailbox.agents()).agents.length, 0);
  failRuntime = false;
  const agent = await f.manager.start(input);
  assert.equal(agent.state, 'starting');
  assert.equal((await f.manager.start(input)).id, agent.id);
});
