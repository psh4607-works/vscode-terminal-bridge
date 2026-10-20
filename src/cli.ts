#!/usr/bin/env node
import { discover, request } from './transport';
function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
export async function main(args: string[]): Promise<void> {
    const options = new Map<string, string | boolean>();
    const positional: string[] = [];
    const flags = new Set(['allow-interrupt', 'enter', 'help', 'clean-shell']);
    const values = new Set(['directory', 'window', 'name', 'cwd', 'command', 'text', 'cursor', 'limit']);
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
        console.log('vscode-terminal [--directory PATH] [--window ID] COMMAND\nCommands:\n  windows\n  list\n  create [--name NAME] [--cwd PATH] [--clean-shell]\n  execute TERMINAL --command CMD [--allow-interrupt]\n  read EXECUTION [--cursor N] [--limit N]\n  status EXECUTION\n  send TERMINAL --text TEXT [--enter]\n  interrupt TERMINAL\n  close TERMINAL');
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
if (require.main === module)
    void main(process.argv.slice(2)).catch((error: unknown) => { const e = error as {
        code?: unknown;
        message?: unknown;
    }; console.log(JSON.stringify({ error: { code: typeof e.code === 'string' ? e.code : 'CLI_ERROR', message: typeof e.message === 'string' ? e.message : 'Unknown error' } })); process.exitCode = 1; });
