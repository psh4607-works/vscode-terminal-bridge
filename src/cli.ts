#!/usr/bin/env node
import { discover, request, defaultDirectory } from './transport';
import { Mailbox } from './mailbox';
import { randomUUID } from 'node:crypto';
function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
export async function main(args: string[]): Promise<void> {
    const options = new Map<string, string | boolean>();
    const positional: string[] = [];
    const flags = new Set(['allow-interrupt', 'enter', 'help', 'clean-shell', 'all']);
    const values = new Set(['directory', 'window', 'name', 'cwd', 'command', 'text', 'cursor', 'limit', 'session', 'from', 'request-id', 'agent']);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h') {
            options.set('help', true);
            continue;
        }
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (options.has(key))
            invalid('Duplicate option --' + key);
        if (flags.has(key))
            options.set(key, true);
        else if (values.has(key)) {
            const value = args[++i];
            if (value === undefined)
                invalid('Missing value for --' + key);
            options.set(key, value);
        }
        else
            invalid('Unknown option ' + arg);
    }
    if (options.has('help')) {
        console.log('vscode-terminal [--directory PATH] [--window ID] COMMAND\nCommands:\n  windows\n  list\n  create [--name NAME] [--cwd PATH] [--clean-shell]\n  execute TERMINAL --command CMD [--allow-interrupt]\n  read EXECUTION [--cursor N] [--limit N]\n  status EXECUTION\n  send TERMINAL --text TEXT [--enter]\n  interrupt TERMINAL\n  close TERMINAL\n  agent register TERMINAL --name NAME [--session UUID]\n  agent list [--cursor CURSOR] [--limit N]\n  message send RECIPIENT --from SENDER --text TEXT --request-id UUID\n  message list AGENT [--cursor CURSOR] [--limit N] [--all]\n  message ack MESSAGE --agent AGENT\nMailbox list/send/ack use the shared --directory, even when --window is supplied.\nRegistration requires a live terminal; --session preserves identity for retries. Messages never type into terminals.');
        return;
    }
    if (positional[0] === 'agent' || positional[0] === 'message') {
        await mailboxCommand(positional, options);
        return;
    }
    const [command, id, ...extra] = positional;
    if (extra.length)
        invalid('Too many positional arguments');
    const directory = options.get('directory') as string | undefined;
    const windows = await discover(directory);
    if (command === 'windows') {
        if (id)
            invalid('windows takes no arguments');
        console.log(JSON.stringify(windows));
        return;
    }
    const methods: Record<string, string> = { list: 'terminal.list', create: 'terminal.create', execute: 'terminal.execute', read: 'execution.read', status: 'execution.status', send: 'terminal.send', interrupt: 'terminal.interrupt', close: 'terminal.close' };
    if (!command || !methods[command])
        invalid('Specify a command; use --help');
    let windowId = options.get('window') as string | undefined;
    if (!windowId) {
        if (windows.length === 0)
            throw Object.assign(new Error('No active VS Code bridge window'), { code: 'NO_WINDOW' });
        if (windows.length !== 1)
            throw Object.assign(new Error('Multiple windows available; select --window ID'), { code: 'AMBIGUOUS_WINDOW' });
        windowId = windows[0].id;
    }
    const params: Record<string, unknown> = {};
    if (['execute', 'send', 'interrupt', 'close', 'read', 'status'].includes(command)) {
        if (!id)
            invalid(command + ' requires an ID');
        params[['read', 'status'].includes(command) ? 'executionId' : 'terminalId'] = id;
    }
    else if (id)
        invalid(command + ' takes no positional arguments');
    const allowed: Record<string, string[]> = { list: [], create: ['name', 'cwd', 'clean-shell'], execute: ['command', 'allow-interrupt'], read: ['cursor', 'limit'], status: [], send: ['text', 'enter'], interrupt: [], close: [] };
    for (const [key, value] of options) {
        if (['directory', 'window'].includes(key))
            continue;
        if (!allowed[command].includes(key))
            invalid('--' + key + ' is not valid for ' + command);
        const target = key === 'allow-interrupt' ? 'allowInterrupt' : key === 'clean-shell' ? 'cleanShell' : key;
        if (key === 'cursor' || key === 'limit') {
            if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
                invalid('--' + key + ' must be a non-negative integer');
            params[target] = Number(value);
        }
        else
            params[target] = value;
    }
    if (command === 'execute') {
        if (!options.has('command'))
            invalid('execute requires --command');
        params.allowInterrupt = options.has('allow-interrupt');
    }
    if (command === 'send') {
        if (!options.has('text'))
            invalid('send requires --text');
        params.enter = options.has('enter');
    }
    console.log(JSON.stringify(await request(windowId, methods[command], params, directory)));
}
async function mailboxCommand(positional: string[], options: Map<string, string | boolean>): Promise<void> {
    const [group, action, id, ...extra] = positional;
    const command = `${group} ${action}`;
    const allowed: Record<string, string[]> = {
        'agent register': ['name', 'session'], 'agent list': ['cursor', 'limit'],
        'message send': ['from', 'text', 'request-id'], 'message list': ['cursor', 'limit', 'all'], 'message ack': ['agent'],
    };
    if (!allowed[command]) invalid('Unknown mailbox command; use --help');
    if (extra.length || (command === 'agent list' ? id !== undefined : !id)) invalid('Invalid arguments for ' + command);
    for (const key of options.keys()) if (!['directory', 'window', ...allowed[command]].includes(key)) invalid('--' + key + ' is not valid for ' + command);
    const directory = options.get('directory') as string | undefined;
    if (command === 'agent register') {
        if (!options.has('name')) invalid('agent register requires --name');
        let windowId = options.get('window') as string | undefined;
        if (!windowId) {
            const windows = await discover(directory);
            if (!windows.length) throw Object.assign(new Error('No active VS Code bridge window'), { code: 'NO_WINDOW' });
            if (windows.length !== 1) throw Object.assign(new Error('Multiple windows available; select --window ID'), { code: 'AMBIGUOUS_WINDOW' });
            windowId = windows[0].id;
        }
        console.log(JSON.stringify(await request(windowId, 'agent.register', { terminalId: id, id: options.get('session') ?? randomUUID(), name: options.get('name') }, directory)));
        return;
    }
    const limit = options.get('limit');
    if (limit !== undefined && (!/^\d+$/.test(String(limit)) || !Number.isSafeInteger(Number(limit)))) invalid('--limit must be a non-negative integer');
    const mailbox = new Mailbox(directory ?? defaultDirectory());
    const page = { cursor: options.get('cursor') as string | undefined, limit: limit === undefined ? undefined : Number(limit) };
    let result: unknown;
    if (command === 'agent list') result = await mailbox.agents(page);
    else if (command === 'message list') result = await mailbox.messages({ ...page, agentId: id, all: options.has('all') });
    else if (command === 'message send') {
        for (const key of ['from', 'text', 'request-id']) if (!options.has(key)) invalid('message send requires --' + key);
        result = await mailbox.send({ id: options.get('request-id') as string, from: options.get('from') as string, to: id, text: options.get('text') as string });
    } else {
        if (!options.has('agent')) invalid('message ack requires --agent');
        result = await mailbox.ack({ id, agentId: options.get('agent') as string });
    }
    console.log(JSON.stringify(result));
}
if (require.main === module)
    void main(process.argv.slice(2)).catch((error: unknown) => { const e = error as {
        code?: unknown;
        message?: unknown;
    }; console.log(JSON.stringify({ error: { code: typeof e.code === 'string' ? e.code : 'CLI_ERROR', message: typeof e.message === 'string' ? e.message : 'Unknown error' } })); process.exitCode = 1; });
