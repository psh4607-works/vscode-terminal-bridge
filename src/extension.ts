import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalBridge, BridgeError } from './core';
import { startServer, defaultDirectory } from './transport';
import { createSmartPaste } from './smart-paste';
import { readMacClipboard } from './macos-clipboard';

let connection: Awaited<ReturnType<typeof startServer>> | undefined;
let bridge: TerminalBridge | undefined;
let cleanShellDirectory: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.isTrusted) return;
  const output = vscode.window.createOutputChannel('Terminal Bridge');
  context.subscriptions.push(output);
  cleanShellDirectory = await mkdtemp(join(tmpdir(), 'vscode-terminal-shell-'));
  bridge = new TerminalBridge(vscode.window, undefined, cleanShellDirectory);
  context.subscriptions.push({ dispose: () => bridge?.dispose() });
  const directory = process.env.VSCODE_TERMINAL_BRIDGE_DIR || defaultDirectory();
  try {
    connection = await startServer({
      directory,
      metadata: { id: randomUUID(), pid: process.pid,
        workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.toString()) },
      dispatch: async (method, params) => {
        if (!vscode.workspace.isTrusted) throw new BridgeError('WORKSPACE_UNTRUSTED', 'Terminal control requires a trusted workspace');
        return bridge!.dispatch(method, params);
      },
    });
    output.appendLine(`Window ID: ${connection.info.id}`);
    output.appendLine(`Connection directory: ${directory}`);
    context.subscriptions.push(vscode.commands.registerCommand('terminalBridge.showConnection', () => {
      void vscode.window.showInformationMessage(`Terminal Bridge window: ${connection?.info.id}. CLI: vscode-terminal windows`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('terminalBridge.smartPaste', createSmartPaste({
      get activeTerminal() { return vscode.window.activeTerminal; },
      get terminals() { return vscode.window.terminals; },
      get remote() { return Boolean(vscode.env.remoteName); },
      get enabled() { return process.platform === 'darwin' && vscode.workspace.isTrusted &&
        vscode.workspace.getConfiguration('terminalBridge').get<boolean>('smartPaste.enabled', true); },
      readClipboard: () => readMacClipboard(),
      fallback: async () => vscode.commands.executeCommand('workbench.action.terminal.paste'),
      warn: message => { void vscode.window.showWarningMessage(message); },
    })));
    return { bridge, connection: connection.info };
  } catch (error) {
    bridge.dispose(); bridge = undefined;
    await rm(cleanShellDirectory, { recursive: true, force: true }); cleanShellDirectory = undefined;
    output.appendLine(`Could not start local bridge: ${String(error)}`);
    throw error;
  }
}

export async function deactivate() {
  bridge?.dispose(); bridge = undefined;
  const closing = connection; connection = undefined;
  if (closing) await closing.close();
  if (cleanShellDirectory) await rm(cleanShellDirectory, { recursive: true, force: true });
  cleanShellDirectory = undefined;
}
