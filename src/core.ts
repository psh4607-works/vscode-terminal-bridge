import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { isAbsolute } from 'node:path';
import type * as vscode from 'vscode';

type Activity = 'unknown' | 'initializing' | 'idle' | 'running' | 'closed';
interface TerminalRecord { id: string; terminal: vscode.Terminal; state: Activity; owned: boolean; active: Set<string> }
interface ExecutionRecord {
  id: string; terminalId: string; command: string; status: 'running' | 'ended' | 'closed';
  exitCode: number | null; outputComplete: boolean; output: string; baseOffset: number;
  startedAt: string; endedAt: string | null; captureError: string | null;
}
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export class TerminalBridge {
  private terminals = new Map<string, TerminalRecord>();
  private byTerminal = new WeakMap<vscode.Terminal, TerminalRecord>();
  private subscriptions: vscode.Disposable[] = [];
  private executions = new Map<string, ExecutionRecord>();
  private byExecution = new WeakMap<vscode.TerminalShellExecution, ExecutionRecord>();
  private disposed = false;
  constructor(private window: typeof vscode.window, private limits = { maxOutputUnits: 65536, maxExecutions: 64 }, private cleanShellDirectory?: string) {
    for (const terminal of window.terminals) this.track(terminal);
    this.subscriptions.push(window.onDidOpenTerminal(t => this.track(t)));
    this.subscriptions.push(window.onDidChangeTerminalShellIntegration(({ terminal }) => {
      const r = this.track(terminal);
      if (r.owned && r.state === 'initializing' && terminal.shellIntegration) r.state = 'idle';
    }));
    this.subscriptions.push(window.onDidCloseTerminal(terminal => {
      const r = this.track(terminal); r.state = 'closed'; this.terminals.delete(r.id);
      for (const id of r.active) {
        const execution = this.executions.get(id);
        if (execution) { execution.status = 'closed'; execution.endedAt = new Date().toISOString(); }
      }
      r.active.clear();
    }));
    this.subscriptions.push(window.onDidStartTerminalShellExecution(({ terminal, execution }) => this.observe(terminal, execution)));
    this.subscriptions.push(window.onDidEndTerminalShellExecution(({ terminal, execution, exitCode }) => {
      const record = this.observe(terminal, execution);
      record.status = 'ended'; record.exitCode = exitCode ?? null; record.endedAt = new Date().toISOString();
      const t = this.track(terminal); t.active.delete(record.id);
      if (t.state !== 'closed' && t.active.size === 0) t.state = exitCode === undefined ? 'unknown' : 'idle';
    }));
  }
  private track(terminal: vscode.Terminal): TerminalRecord {
    let record = this.byTerminal.get(terminal);
    if (!record) {
      record = { id: randomUUID(), terminal, state: 'unknown', owned: false, active: new Set() };
      this.byTerminal.set(terminal, record); this.terminals.set(record.id, record);
    }
    return record;
  }
  private async describe(record: TerminalRecord) {
    // PID is optional: a terminal implementation must not stall listing forever.
    let timer: number | NodeJS.Timeout | undefined;
    const pid = await Promise.race([Promise.resolve(record.terminal.processId).catch(() => undefined),
      new Promise<undefined>(r => { timer = setTimeout(r, 100); })]);
    clearTimeout(timer);
    return { id: record.id, name: record.terminal.name, pid: pid ?? null, state: record.state,
      owned: record.owned, shellIntegration: !!record.terminal.shellIntegration,
      cwd: record.terminal.shellIntegration?.cwd?.toString() ?? null, activeExecutionIds: [...record.active] };
  }
  private terminal(params: Record<string, unknown>): TerminalRecord {
    const id = text(params.terminalId, 'terminalId');
    const record = this.terminals.get(id);
    if (!record) throw new BridgeError('TERMINAL_NOT_FOUND', 'Terminal no longer exists in this window');
    return record;
  }
  private observe(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): ExecutionRecord {
    const existing = this.byExecution.get(execution);
    if (existing) return existing;
    const t = this.track(terminal);
    const record: ExecutionRecord = { id: randomUUID(), terminalId: t.id,
      command: execution.commandLine.value.slice(0, 32768), status: 'running', exitCode: null,
      outputComplete: false, output: '', baseOffset: 0, startedAt: new Date().toISOString(), endedAt: null, captureError: null };
    this.byExecution.set(execution, record); this.executions.set(record.id, record);
    while (this.executions.size > this.limits.maxExecutions) {
      const oldest = [...this.executions.values()].find(r => r.status !== 'running')
        ?? this.executions.values().next().value!;
      oldest.output = ''; this.executions.delete(oldest.id);
    }
    t.active.add(record.id); t.state = 'running';
    // Calling read synchronously matters: data before the first read cannot be replayed.
    try { void this.consume(record, execution.read()); }
    catch (error) { record.captureError = String(error); record.outputComplete = true; }
    return record;
  }
  private async consume(record: ExecutionRecord, stream: AsyncIterable<string>) {
    try {
      for await (const chunk of stream) {
        if (this.disposed) return;
        if (!this.executions.has(record.id)) continue;
        record.output += chunk;
        const excess = record.output.length - this.limits.maxOutputUnits;
        if (excess > 0) { record.output = record.output.slice(excess); record.baseOffset += excess; }
      }
    }
    catch (error) { record.captureError = String(error); }
    finally { record.outputComplete = true; }
  }
  private execution(params: Record<string, unknown>): ExecutionRecord {
    const record = this.executions.get(text(params.executionId, 'executionId'));
    if (!record) throw new BridgeError('EXECUTION_NOT_FOUND', 'Execution is unknown or no longer retained');
    return record;
  }
  private executionStatus(r: ExecutionRecord) {
    const { output, ...status } = r;
    return { ...status, nextOffset: r.baseOffset + output.length, offsetUnit: 'utf16' };
  }
  async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    if (this.disposed) throw new BridgeError('BRIDGE_CLOSED', 'Terminal bridge has been disposed');
    const params = object(rawParams);
    if (method === 'terminal.list') return Promise.all([...this.terminals.values()].map(r => this.describe(r)));
    if (method === 'terminal.create') {
      const name = params.name === undefined ? 'AI Terminal' : text(params.name, 'name', 200);
      const cwd = params.cwd === undefined ? undefined : text(params.cwd, 'cwd', 4096);
      const cleanShell = boolean(params.cleanShell, 'cleanShell');
      if (cwd && !isAbsolute(cwd)) throw new BridgeError('INVALID_PARAMS', 'cwd must be an absolute path');
      if (cleanShell && !this.cleanShellDirectory) throw new BridgeError('CLEAN_SHELL_UNAVAILABLE', 'A clean zsh startup directory is not available');
      const terminal = this.window.createTerminal({ name, cwd,
        ...(cleanShell ? { shellPath: '/bin/zsh', env: { ZDOTDIR: this.cleanShellDirectory! } } : {}) });
      const r = this.track(terminal); r.owned = true;
      if (r.state === 'unknown') r.state = terminal.shellIntegration ? 'idle' : 'initializing';
      return this.describe(r);
    }
    if (method === 'terminal.close') {
      const r = this.terminal(params); r.terminal.dispose();
      return { terminalId: r.id, closeRequested: true };
    }
    if (method === 'terminal.send' || method === 'terminal.interrupt') {
      const t = this.terminal(params);
      const input = method === 'terminal.interrupt' ? '\x03' : text(params.text, 'text');
      const enter = method === 'terminal.send' && boolean(params.enter, 'enter');
      t.terminal.sendText(input, enter);
      if (t.state !== 'running') t.state = 'unknown';
      return { terminalId: t.id, sent: true, tracked: false };
    }
    if (method === 'terminal.execute') {
      const t = this.terminal(params);
      const command = text(params.command, 'command');
      const allowInterrupt = boolean(params.allowInterrupt, 'allowInterrupt');
      if (!t.terminal.shellIntegration) throw new BridgeError('SHELL_INTEGRATION_UNAVAILABLE', 'Wait for shell integration; no untracked execution fallback is used');
      if (!allowInterrupt && t.state === 'running') throw new BridgeError('TERMINAL_BUSY', 'Terminal already has a running execution');
      if (!allowInterrupt && t.state !== 'idle') throw new BridgeError('TERMINAL_STATE_UNKNOWN', 'Cannot prove terminal is idle; use a new terminal or explicitly allow interruption');
      if ([...this.executions.values()].filter(r => r.status === 'running').length >= this.limits.maxExecutions)
        throw new BridgeError('EXECUTION_LIMIT', 'Too many active executions; finish an existing execution before starting another');
      const previous = t.state; t.state = 'running';
      try {
        const execution = t.terminal.shellIntegration.executeCommand(command);
        return this.executionStatus(this.observe(t.terminal, execution));
      } catch (error) {
        t.state = t.active.size ? 'running' : previous;
        throw new BridgeError('EXECUTION_FAILED', String(error));
      }
    }
    if (method === 'execution.status') return this.executionStatus(this.execution(params));
    if (method === 'execution.read') {
      const record = this.execution(params);
      const cursor = integer(params.cursor ?? 0, 'cursor', 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(params.limit ?? 16384, 'limit', 1, 65536);
      if (cursor > record.baseOffset + record.output.length) throw new BridgeError('INVALID_PARAMS', 'cursor is beyond the current output end');
      const start = Math.max(cursor, record.baseOffset);
      const output = record.output.slice(start - record.baseOffset, start - record.baseOffset + limit);
      return { ...this.executionStatus(record), output, nextCursor: start + output.length, truncated: cursor < record.baseOffset };
    }
    throw new BridgeError('METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    for (const execution of this.executions.values()) execution.output = '';
    this.executions.clear(); this.terminals.clear();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_PARAMS', 'params must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 32768): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0'))
    throw new BridgeError('INVALID_PARAMS', `${name} must be a nonempty string of at most ${max} characters without NUL`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new BridgeError('INVALID_PARAMS', `${name} must be a boolean`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new BridgeError('INVALID_PARAMS', `${name} must be an integer between ${min} and ${max}`);
  return value;
}
