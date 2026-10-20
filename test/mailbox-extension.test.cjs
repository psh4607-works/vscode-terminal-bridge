const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./helpers.cjs');
const { discover, request } = require('../dist/transport');
const { Mailbox } = require('../dist/mailbox');

test('registration verifies a live terminal but never injects input; durable IDs survive reactivation', async t => {
  const directory = await fs.mkdtemp('/tmp/vtb-mail-extension-');
  const previous = process.env.VSCODE_TERMINAL_BRIDGE_DIR;
  process.env.VSCODE_TERMINAL_BRIDGE_DIR = directory;
  const f = fixture();
  const terminal = f.window.createTerminal({ name: 'Codex fixture' });
  f.window.createOutputChannel = () => ({ appendLine() {}, dispose() {} });
  const api = { window: f.window, env: {}, workspace: { isTrusted: true, workspaceFolders: [] },
    commands: { registerCommand: () => ({ dispose() {} }) } };
  const original = Module._load;
  let extension;
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? api : original.call(this, name, ...args); };
    extension = require('../dist/extension');
  } finally { Module._load = original; }
  t.after(async () => {
    await extension.deactivate();
    if (previous === undefined) delete process.env.VSCODE_TERMINAL_BRIDGE_DIR;
    else process.env.VSCODE_TERMINAL_BRIDGE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  await extension.activate({ subscriptions: [] });
  const [first] = await discover(directory);
  const [before] = await request(first.id, 'terminal.list', {}, directory);
  const sessionId = randomUUID();
  const agent = await request(first.id, 'agent.register', { id: sessionId, name: 'reviewer', terminalId: before.id }, directory);
  assert.equal(agent.id, sessionId);
  assert.deepEqual(agent.registration, { windowId: first.id, terminalId: before.id });
  assert.deepEqual(terminal.sent, []);
  await extension.deactivate();
  const offline = await new Mailbox(directory).agents();
  assert.equal(offline.agents[0].id, sessionId);
  assert.equal(offline.agents[0].registration, undefined, 'no persisted live-terminal claim');
  await extension.activate({ subscriptions: [] });
  const [second] = await discover(directory);
  await assert.rejects(request(second.id, 'agent.register', { id: sessionId, name: 'reviewer', terminalId: before.id }, directory),
    { code: 'TERMINAL_NOT_FOUND' });
  const [after] = await request(second.id, 'terminal.list', {}, directory);
  const rebound = await request(second.id, 'agent.register', { id: sessionId, name: 'reviewer', terminalId: after.id }, directory);
  assert.equal(rebound.id, agent.id);
  assert.equal(rebound.createdAt, agent.createdAt);
  api.workspace.isTrusted = false;
  await assert.rejects(request(second.id, 'agent.register', { id: randomUUID(), name: 'untrusted', terminalId: after.id }, directory),
    { code: 'WORKSPACE_UNTRUSTED' });
  assert.deepEqual(terminal.sent, []);
});
