import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { BridgeError } from './core';

interface Agent { id: string; name: string; createdAt: string }
interface Message { id: string; from: string; to: string; text: string; createdAt: string }
interface Receipt { id: string; agentId: string; acknowledgedAt: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 65536;
function fail(code: string, message: string): never { throw new BridgeError(code, message); }
function id(value: unknown): string {
  if (!isId(value)) fail('INVALID_PARAMS', 'IDs must be lowercase UUIDs');
  return value;
}
function isId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0'))
    fail('INVALID_PARAMS', `Text must be nonblank, at most ${maximum} characters, and contain no NUL`);
  return value;
}
function privateStat(stat: Stats) {
  return (!process.getuid || stat.uid === process.getuid()) && !(stat.mode & 0o077);
}
function isAgent(value: any): value is Agent {
  return value && isId(value.id) && typeof value.name === 'string' && !!value.name.trim() &&
    value.name.length <= 200 && !value.name.includes('\0') && validDate(value.createdAt);
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
function isMessage(value: any): value is Message {
  return value && isId(value.id) && isId(value.from) && isId(value.to) &&
    typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 8192 && !value.text.includes('\0') && validDate(value.createdAt);
}
function isReceipt(value: any): value is Receipt {
  return value && isId(value.id) && isId(value.agentId) && validDate(value.acknowledgedAt);
}

// Immutable records are published with link(), never an overwriting rename.
// Independent CLI processes and VS Code windows need no shared in-memory lock.
export class Mailbox {
  constructor(private directory: string) {}
  private async folder(kind: string) {
    let current = path.resolve(this.directory);
    for (const part of ['', 'mailbox', kind]) {
      if (part) current = path.join(current, part);
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !privateStat(stat))
        fail('UNSAFE_MAILBOX', 'Mailbox directories must be owned by this user with mode 0700');
      // Sync even if another process just created it but has not synced its parent yet.
      const parent = await fs.open(path.dirname(current), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return current;
  }
  private async read<T>(folder: string, recordId: string, validate: (value: any) => value is T): Promise<T | undefined> {
    const filename = path.join(folder, id(recordId) + '.json');
    let handle;
    try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('UNSAFE_MAILBOX', 'Mailbox records cannot be symbolic links');
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !privateStat(stat)) fail('UNSAFE_MAILBOX', 'Mailbox records must be private regular files');
      if (stat.size > MAX_RECORD_BYTES) fail('MAILBOX_CORRUPT', 'Mailbox record exceeds size limit');
      let value;
      try { value = JSON.parse(await handle.readFile('utf8')); }
      catch { fail('MAILBOX_CORRUPT', 'Mailbox record is not valid JSON'); }
      if (!validate(value) || (value as { id: string }).id !== recordId)
        fail('MAILBOX_CORRUPT', 'Mailbox record does not match its schema or ID');
      return value;
    } finally { await handle.close(); }
  }
  private async publish<T extends { id: string }>(folder: string, value: T,
    validate: (value: any) => value is T): Promise<T> {
    const temp = path.join(folder, '.' + randomUUID() + '.tmp');
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try {
      try { await fs.link(temp, path.join(folder, id(value.id) + '.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const dir = await fs.open(folder, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return (await this.read(folder, value.id, validate))!;
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  private async records<T>(kind: string, validate: (value: any) => value is T): Promise<T[]> {
    const folder = await this.folder(kind);
    const names = (await fs.readdir(folder)).filter(name => name.endsWith('.json'));
    const records: T[] = [];
    for (const name of names) {
      if (!UUID.test(name.slice(0, -5))) fail('MAILBOX_CORRUPT', 'Unexpected mailbox record filename');
      const record = await this.read(folder, name.slice(0, -5), validate);
      if (record) records.push(record);
    }
    return records;
  }
  async register(agentId: string, name: string): Promise<Agent> {
    const candidate = { id: id(agentId), name: text(name, 200), createdAt: new Date().toISOString() };
    const result = await this.publish(await this.folder('agents'), candidate, isAgent);
    if (result.name !== candidate.name) fail('ID_CONFLICT', 'Session ID is already registered with a different name');
    return result;
  }
  async agents(options: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? '' : id(options.cursor);
    const records = (await this.records('agents', isAgent)).sort((a, b) => a.id.localeCompare(b.id)).filter(a => a.id > cursor);
    const agents = records.slice(0, limit);
    return { agents, nextCursor: records.length > limit ? agents.at(-1)!.id : null };
  }
  private async agent(agentId: string) {
    const result = await this.read(await this.folder('agents'), id(agentId), isAgent);
    if (!result) fail('AGENT_NOT_FOUND', 'Register the session before using its mailbox');
    return result;
  }
  async send(input: { id: string; from: string; to: string; text: string }): Promise<Message> {
    const candidate = { id: id(input.id), from: id(input.from), to: id(input.to), text: text(input.text, 8192),
      createdAt: new Date().toISOString() };
    await this.agent(candidate.from); await this.agent(candidate.to);
    const result = await this.publish(await this.folder('messages'), candidate, isMessage);
    if (result.from !== candidate.from || result.to !== candidate.to || result.text !== candidate.text)
      fail('ID_CONFLICT', 'Request ID already belongs to a different message; retry with its original payload');
    return result;
  }
  async messages(options: { agentId: string; cursor?: string; limit?: number; all?: boolean }) {
    await this.agent(options.agentId);
    const limit = pageLimit(options.limit);
    const cursor = options.cursor ?? '';
    if (cursor && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z_[0-9a-f-]{36}$/.test(cursor))
      fail('INVALID_PARAMS', 'Invalid message cursor; use nextCursor from a previous response');
    if (options.all !== undefined && typeof options.all !== 'boolean') fail('INVALID_PARAMS', 'all must be a boolean');
    const records = (await this.records('messages', isMessage)).filter(message => message.to === options.agentId &&
      message.createdAt + '_' + message.id > cursor).sort((a, b) => (a.createdAt + a.id).localeCompare(b.createdAt + b.id));
    const folder = await this.folder('acks');
    const selected: (Message & { acknowledgedAt: string | null })[] = [];
    for (const message of records) {
      const receipt = await this.read(folder, message.id, isReceipt);
      if (receipt && receipt.agentId !== message.to) fail('MAILBOX_CORRUPT', 'Receipt does not match message recipient');
      if (options.all || !receipt) selected.push({ ...message, acknowledgedAt: receipt?.acknowledgedAt ?? null });
      if (selected.length > limit) break;
    }
    const messages = selected.slice(0, limit);
    const last = messages.at(-1);
    return { messages, nextCursor: selected.length > limit ? last!.createdAt + '_' + last!.id : null };
  }
  async ack(input: { id: string; agentId: string }): Promise<Receipt> {
    const messageId = id(input.id), agentId = id(input.agentId);
    await this.agent(agentId);
    const message = await this.read(await this.folder('messages'), messageId, isMessage);
    if (!message) fail('MESSAGE_NOT_FOUND', 'Message does not exist');
    if (message.to !== agentId) fail('WRONG_RECIPIENT', 'Only the intended recipient can acknowledge this message');
    const receipt = await this.publish(await this.folder('acks'), {
      id: messageId, agentId, acknowledgedAt: new Date().toISOString(),
    }, isReceipt);
    if (receipt.agentId !== agentId) fail('MAILBOX_CORRUPT', 'Receipt does not match message recipient');
    return receipt;
  }
}
function pageLimit(value: unknown = 50): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100)
    fail('INVALID_PARAMS', 'limit must be an integer between 1 and 100');
  return value as number;
}
