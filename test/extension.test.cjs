const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discover, request } = require('../dist/transport');

test('extension activates a real socket only in a trusted workspace and removes it on shutdown', async () => {
  const directory = await fs.mkdtemp('/tmp/vtb-activation-');
  process.env.VSCODE_TERMINAL_BRIDGE_DIR = directory;
  const disposable = { dispose() {} };
  const window = { terminals: [], createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showInformationMessage() {},
    onDidOpenTerminal: () => disposable, onDidCloseTerminal: () => disposable,
    onDidChangeTerminalShellIntegration: () => disposable, onDidStartTerminalShellExecution: () => disposable, onDidEndTerminalShellExecution: () => disposable };
  const commands = new Map(); let pasted = 0;
  const api = { window, env: {}, workspace: { isTrusted: false, workspaceFolders: [], getConfiguration: () => ({ get: () => false }) }, commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async id => { assert.equal(id, 'workbench.action.terminal.paste'); pasted++; } } };
  const original = Module._load;
  let extension;
  try {
    Module._load = function (id, ...args) { return id === 'vscode' ? api : original.call(this, id, ...args); };
    try { extension = require('../dist/extension'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  } finally { Module._load = original; }
  try {
    assert.equal(typeof extension?.activate, 'function', 'extension must expose an activation entrypoint');
    await extension.activate({ subscriptions: [] });
    assert.deepEqual(await discover(directory), []);
    api.workspace.isTrusted = true;
    await extension.activate({ subscriptions: [] });
    const instances = await discover(directory); assert.equal(instances.length, 1);
    assert.equal(typeof commands.get('terminalBridge.smartPaste'), 'function', 'register smart paste command');
    window.activeTerminal = { sendText() { throw new Error('unexpected write'); } };
    await commands.get('terminalBridge.smartPaste')(); assert.equal(pasted, 1);
    assert.deepEqual(await request(instances[0].id, 'terminal.list', {}, directory), []);
    await extension.deactivate(); assert.deepEqual(await discover(directory), []);
  } finally { if (extension?.deactivate) await extension.deactivate(); delete process.env.VSCODE_TERMINAL_BRIDGE_DIR; await fs.rm(directory, { recursive: true, force: true }); }
});
