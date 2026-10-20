'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async function run() {
  const root = process.env.BRIDGE_TEST_ROOT;
  const summary = { startedAt: new Date().toISOString(), vscodeVersion: vscode.version, checks: [] };
  const terminals = [];
  let external;
  let pasteTerminal;
  let pasteEmitter;
  let managedAgent;
  let managedWindow;
  async function cli(...args) {
    try {
      const { stdout } = await exec(process.env.BRIDGE_NODE_PATH, [path.join(root, 'dist/cli.js'), '--directory', process.env.VSCODE_TERMINAL_BRIDGE_DIR, ...args], { timeout: 15000 });
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error.stdout) {
        const result = JSON.parse(error.stdout.trim());
        if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }
      throw error;
    }
  }
  async function poll(fn, label, timeout = 25000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(150); }
    throw new Error('Timed out: ' + label);
  }
  const check = name => summary.checks.push(name);
  try {
    const extension = vscode.extensions.getExtension('seongho.vscode-terminal-bridge');
    assert.ok(extension, 'development extension discovered');
    await extension.activate();
    const windows = await poll(async () => { const items = await cli('windows'); return items.length === 1 && items; }, 'one bridge window');
    assert.equal(windows.length, 1); check('CLI discovers isolated VS Code window');
    external = vscode.window.createTerminal({ name: 'External integration terminal' });
    const existing = await poll(async () => (await cli('list')).find(t => t.name === external.name && t.shellIntegration), 'external terminal shell integration ready');
    assert.equal(existing.state, 'unknown');
    await assert.rejects(cli('execute', existing.id, '--command', 'printf SHOULD_NOT_RUN'), error => ['TERMINAL_STATE_UNKNOWN'].includes(error.code));
    check('Externally created terminal is unknown and protected');
    const created = await cli('create', '--name', 'Bridge integration terminal', '--clean-shell');
    terminals.push(created.id);
    await poll(async () => (await cli('list')).find(t => t.id === created.id && t.shellIntegration && t.state === 'idle'), 'shell integration and idle');
    check('CLI creates real terminal with shell integration');
    const senderId = randomUUID(), receiverId = randomUUID(), requestId = randomUUID();
    const sender = await cli('--window', windows[0].id, 'agent', 'register', created.id,
      '--name', 'sender', '--session', senderId);
    const receiver = await cli('--window', windows[0].id, 'agent', 'register', existing.id,
      '--name', 'reviewer', '--session', receiverId);
    assert.equal(sender.registration.terminalId, created.id);
    assert.equal(receiver.id, receiverId);
    const sendArgs = ['message', 'send', receiverId, '--from', senderId, '--text', 'Review this fixture', '--request-id', requestId];
    const message = await cli(...sendArgs);
    assert.deepEqual(await cli(...sendArgs), message);
    const inbox = await cli('message', 'list', receiverId);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].id, requestId);
    await assert.rejects(cli('message', 'ack', requestId, '--agent', senderId), { code: 'WRONG_RECIPIENT' });
    const receipt = await cli('message', 'ack', requestId, '--agent', receiverId);
    assert.deepEqual(await cli('message', 'ack', requestId, '--agent', receiverId), receipt);
    assert.equal((await cli('message', 'list', receiverId)).messages.length, 0);
    assert.equal((await cli('message', 'list', receiverId, '--all')).messages[0].acknowledgedAt, receipt.acknowledgedAt);
    assert.equal((await cli('list')).find(t => t.id === created.id).state, 'idle');
    check('Real extension verifies registration; separate CLI processes persist, deduplicate and acknowledge messages without terminal input');
    const marker = 'BRIDGE_REAL_OUTPUT_26391';
    const execution = await cli('execute', created.id, '--command', `printf '${marker}'; false`);
    const executionId = execution.id || execution.executionId;
    assert.ok(executionId);
    let output = '';
    let cursor = 0;
    const completed = await poll(async () => {
      const read = await cli('read', executionId, '--cursor', String(cursor));
      output += read.output ?? read.data ?? '';
      cursor = read.nextCursor ?? read.nextOffset ?? cursor;
      const status = await cli('status', executionId);
      summary.lastExecution = { read, status, output, terminals: await cli('list') };
      return read.outputComplete && (status.status === 'ended' || status.ended || status.endedAt) && status;
    }, 'output and command completion');
    assert.ok(output.includes(marker), 'real command output captured');
    assert.equal(completed.exitCode, 1); check('CLI captures real output and nonzero exit status');
    const long = await cli('execute', created.id, '--command', 'sleep 20');
    const longId = long.id || long.executionId;
    await poll(async () => (await cli('list')).find(t => t.id === created.id && t.state === 'running'), 'running state');
    await assert.rejects(cli('execute', created.id, '--command', 'printf SHOULD_NOT_INTERRUPT'), error => ['TERMINAL_BUSY', 'TERMINAL_NOT_IDLE', 'UNSAFE_TERMINAL_STATE'].includes(error.code));
    const active = await cli('status', longId);
    assert.ok(!active.endedAt && !active.ended && active.status !== 'ended'); check('Busy terminal rejects execution without implicit interrupt');
    await cli('interrupt', created.id);
    await poll(async () => { const s = await cli('status', longId); return s.status === 'ended' || s.ended || s.endedAt; }, 'explicit interrupt');
    check('Explicit interrupt ends running execution');
    await cli('close', created.id);
    await poll(async () => !(await cli('list')).some(t => t.id === created.id), 'terminal closes');
    terminals.length = 0;
    check('CLI closes created terminal');
    assert.ok((await vscode.commands.getCommands()).includes('terminalBridge.smartPaste'));
    const received = [];
    pasteEmitter = new vscode.EventEmitter();
    pasteTerminal = vscode.window.createTerminal({ name: 'Smart paste fixture', pty: {
      onDidWrite: pasteEmitter.event, open() {}, close() {}, handleInput: data => received.push(data)
    } });
    pasteTerminal.show();
    await poll(() => vscode.window.activeTerminal === pasteTerminal, 'paste fixture focused');
    const { createSmartPaste } = require(path.join(root, 'dist/smart-paste'));
    const paste = createSmartPaste({
      get activeTerminal() { return vscode.window.activeTerminal; },
      get terminals() { return vscode.window.terminals; }, remote: false, enabled: true,
      readClipboard: async () => ({ kind: 'files', paths: ['/tmp/screenshot.png', '/tmp/movie clip.mov', '/tmp/folder'] }),
      fallback: async () => { throw new Error('unexpected fallback'); },
      warn: () => { throw new Error('unexpected warning'); }
    });
    await paste();
    await poll(() => received.length, 'real terminal receives media paste');
    assert.equal(received.join(''), "\x1b[200~/tmp/screenshot.png\x1b[201~ '/tmp/movie clip.mov' '/tmp/folder' ");
    assert.doesNotMatch(received.join(''), /[\r\n]/);
    check('Smart paste command registered; real VS Code PTY receives image frame and quoted video/folder paths without Enter');
    if (process.env.BRIDGE_TEST_CODEX === '1') {
      const workspace = process.env.BRIDGE_TEST_WORKSPACE;
      assert.ok(workspace && path.isAbsolute(workspace), 'managed test needs the harness isolated workspace');
      assert.deepEqual(await fs.readdir(workspace), [], 'managed fixture workspace starts empty');
      managedWindow = windows[0].id;
      const name = 'Managed Codex integration ' + randomUUID();
      const launchArgs = ['--window', managedWindow, 'agent', 'start', '--name', name,
        '--cwd', workspace, '--request-id', randomUUID()];
      if (process.env.BRIDGE_TEST_CODEX_MODEL) launchArgs.push('--model', process.env.BRIDGE_TEST_CODEX_MODEL);
      summary.managed = { enabled: true, isolatedWorkspace: true, turns: [], stopped: false };
      const started = await cli(...launchArgs);
      managedAgent = started.id;
      const idle = await poll(async () => {
        const status = await cli('--window', managedWindow, 'agent', 'status', managedAgent);
        if (['error', 'closed', 'uncertain'].includes(status.state)) {
          throw Object.assign(new Error('Managed Codex did not become idle'), { code: status.error || 'MANAGED_START_FAILED' });
        }
        return status.state === 'idle' && status;
      }, 'real managed Codex idle', 120000);
      assert.ok(idle.threadId && idle.terminalId, 'managed launch binds a thread and native terminal');
      const nativeTerminal = vscode.window.terminals.find(terminal => terminal.name === name);
      assert.ok(nativeTerminal, 'native Codex terminal exists in the isolated VS Code window');
      assert.equal((await cli(...launchArgs)).id, managedAgent, 'same live launch request deduplicates');
      check('Actual installed Codex starts with a native remote TUI in the isolated workspace');
      for (let index = 1; index <= 2; index++) {
        const messageId = randomUUID();
        const marker = 'BRIDGE_MANAGED_ACK_' + index;
        await cli('message', 'send', managedAgent, '--from', senderId, '--request-id', messageId, '--text',
          `Integration fixture only: acknowledge this message (${messageId}) with the mailbox CLI described in your developer instructions, ` +
          `then reply exactly ${marker}. Do not send peer messages, edit project files, or perform any other task. ` +
          `Your working directory is a disposable empty integration workspace.`);
        const observed = await poll(async () => {
          const delivery = await cli('message', 'delivery', messageId, '--agent', managedAgent);
          const status = await cli('--window', managedWindow, 'agent', 'status', managedAgent);
          if (['error', 'closed', 'uncertain'].includes(status.state)) {
            throw Object.assign(new Error('Managed Codex cannot continue the integration turn'), { code: status.error || 'MANAGED_TURN_FAILED' });
          }
          if (delivery.stage !== 'turn_completed') return false;
          if (delivery.status !== 'completed') throw Object.assign(new Error('Managed integration turn did not complete successfully'), { code: 'MANAGED_TURN_' + delivery.status.toUpperCase() });
          const all = await cli('message', 'list', managedAgent, '--all');
          const message = all.messages.find(item => item.id === messageId);
          return message?.acknowledgedAt && status.state === 'idle' && { delivery, acknowledgedAt: message.acknowledgedAt };
        }, 'managed message ' + index + ' completes and explicitly acknowledges', 120000);
        summary.managed.turns.push({ stage: observed.delivery.stage, status: observed.delivery.status,
          acknowledged: true, markerRequested: marker });
        if (index === 2) assert.notEqual(observed.delivery.turnId, summary.managed.firstTurnId, 'second message starts a new turn');
        else summary.managed.firstTurnId = observed.delivery.turnId;
        check('Actual managed Codex automatically handles and acknowledges message ' + index);
      }
      assert.deepEqual(await fs.readdir(workspace), [], 'managed turns did not modify the fixture workspace');
      const stopped = await cli('--window', managedWindow, 'agent', 'stop', managedAgent);
      assert.equal(stopped.state, 'closed');
      await poll(async () => !vscode.window.terminals.includes(nativeTerminal) &&
        !(await cli('list')).some(terminal => terminal.id === idle.terminalId), 'managed native terminal removed', 15000);
      summary.managed.stopped = true;
      delete summary.managed.firstTurnId;
      check('Managed stop removes its native terminal; fixture workspace remains empty');
    } else summary.managed = { enabled: false, reason: 'Set BRIDGE_TEST_CODEX=1 to exercise actual Codex and model calls' };
    summary.passed = true;
  } catch (error) { summary.passed = false; summary.error = { message: error.message, code: error.code }; throw error;
  } finally {
    if (managedAgent) {
      try { await cli('--window', managedWindow, 'agent', 'stop', managedAgent); }
      catch (error) { summary.managedCleanupError = { code: error.code || 'MANAGED_CLEANUP_FAILED' }; }
    }
    for (const id of terminals) { try { await cli('interrupt', id); await cli('close', id); } catch {} }
    external?.dispose();
    pasteTerminal?.dispose(); pasteEmitter?.dispose();
    summary.finishedAt = new Date().toISOString();
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'artifacts/integration.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
  }
};
