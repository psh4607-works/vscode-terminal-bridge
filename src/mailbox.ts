import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { BridgeError } from './core';

interface Agent { id: string; name: string; createdAt: string }
interface Message { id: string; from: string; to: string; text: string; createdAt: string }
interface DeliveryAttempt { id: string; agentId: string; runId: string; threadId: string; windowId: string; attemptedAt: string }
type DeliveryStatus = 'completed' | 'failed' | 'interrupted';
interface DeliveryStarted { id: string; agentId: string; runId: string; turnId: string; startedAt: string }
interface DeliveryCompleted { id: string; agentId: string; runId: string; turnId: string; completedAt: string; status: DeliveryStatus }
export type DeliveryState = { id: string; agentId: string; stage: 'queued' } |
  (DeliveryAttempt & { stage: 'submission_unknown' }) |
  (DeliveryAttempt & DeliveryStarted & { stage: 'turn_started' }) |
  (DeliveryAttempt & DeliveryStarted & DeliveryCompleted & { stage: 'turn_completed' });
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
function hasOnlyKeys(value: any, keys: string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}
function isDeliveryAttempt(value: any): value is DeliveryAttempt {
  return value && isId(value.id) && isId(value.agentId) && isId(value.runId) &&
    isId(value.threadId) && isId(value.windowId) && validDate(value.attemptedAt) &&
    hasOnlyKeys(value, ['id', 'agentId', 'runId', 'threadId', 'windowId', 'attemptedAt']);
}
function isTurnId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\x00-\x20\x7f]/.test(value);
}
function turnId(value: unknown): string {
  if (!isTurnId(value)) fail('INVALID_PARAMS', 'turnId must be a nonblank identifier without control characters, at most 512 characters');
  return value;
}
function isDeliveryStarted(value: any): value is DeliveryStarted {
  return value && isId(value.id) && isId(value.agentId) && isId(value.runId) &&
    isTurnId(value.turnId) && validDate(value.startedAt) &&
    hasOnlyKeys(value, ['id', 'agentId', 'runId', 'turnId', 'startedAt']);
}
function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return value === 'completed' || value === 'failed' || value === 'interrupted';
}
function isDeliveryCompleted(value: any): value is DeliveryCompleted {
  return value && isId(value.id) && isId(value.agentId) && isId(value.runId) &&
    isTurnId(value.turnId) && validDate(value.completedAt) && isDeliveryStatus(value.status) &&
    hasOnlyKeys(value, ['id', 'agentId', 'runId', 'turnId', 'completedAt', 'status']);
}
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function messageKey(message: Message) { return message.createdAt + '_' + message.id; }
function sameMessage(left: Message, right: Message) {
  return left.id === right.id && left.from === right.from && left.to === right.to && left.text === right.text;
}

// Immutable records are published with link(), never an overwriting rename.
// Independent CLI processes and VS Code windows need no shared in-memory lock.
export class Mailbox {
  constructor(private directory: string) {}
  private async folder(kind: string, create: true, recipient?: string): Promise<string>;
  private async folder(kind: string, create?: false, recipient?: string): Promise<string | undefined>;
  private async folder(kind: string, create = false, recipient?: string) {
    let current = path.resolve(this.directory);
    for (const part of ['', 'mailbox', kind, ...(recipient ? [id(recipient)] : [])]) {
      if (part) current = path.join(current, part);
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current).catch(error => {
        if (!create && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) return undefined;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !privateStat(stat))
        fail('UNSAFE_MAILBOX', 'Mailbox directories must be owned by this user with mode 0700');
      if (create) {
        // Writers also cover directories just created by another process; readers never sync.
        const parent = await fs.open(path.dirname(current), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    }
    return current;
  }
  private async read<T>(folder: string | undefined, recordId: string, validate: (value: any) => value is T): Promise<T | undefined> {
    id(recordId);
    if (!folder) return undefined;
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
      const stored = await this.read(folder, value.id, validate);
      if (!stored) fail('MAILBOX_CORRUPT', 'Published record disappeared before it could be verified');
      return stored;
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  private async records<T>(kind: string, validate: (value: any) => value is T, recipient?: string): Promise<T[]> {
    const folder = await this.folder(kind, false, recipient);
    if (!folder) return [];
    const names = (await fs.readdir(folder)).filter(name => name.endsWith('.json'));
    const ids = names.map(name => name.slice(0, -5));
    if (ids.some(recordId => !UUID.test(recordId))) fail('MAILBOX_CORRUPT', 'Unexpected mailbox record filename');
    const records: T[] = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = await Promise.all(ids.slice(offset, offset + 8).map(recordId => this.read(folder, recordId, validate)));
      for (const record of batch) if (record) records.push(record);
    }
    return records;
  }
  async register(agentId: string, name: string): Promise<Agent> {
    const candidate = { id: id(agentId), name: text(name, 200), createdAt: new Date().toISOString() };
    const result = await this.publish(await this.folder('agents', true), candidate, isAgent);
    if (result.name !== candidate.name) fail('ID_CONFLICT', 'Session ID is already registered with a different name');
    return result;
  }
  async agents(options: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? '' : id(options.cursor);
    const records = (await this.records('agents', isAgent)).sort((a, b) => compare(a.id, b.id)).filter(a => a.id > cursor);
    const agents = records.slice(0, limit);
    return { agents, nextCursor: records.length > limit ? agents.at(-1)!.id : null };
  }
  private async agent(agentId: string) {
    const result = await this.read(await this.folder('agents'), id(agentId), isAgent);
    if (!result) fail('AGENT_NOT_FOUND', 'Register the session before using its mailbox');
    return result;
  }
  private async checkLayout() {
    const folder = await this.folder('messages');
    if (folder && (await fs.readdir(folder)).some(name => name.endsWith('.json')))
      fail('MAILBOX_LAYOUT_UNSUPPORTED', 'Pre-release flat mailbox detected; preserve it and migrate before using this version');
  }
  async send(input: { id: string; from: string; to: string; text: string }): Promise<Message> {
    const candidate = { id: id(input.id), from: id(input.from), to: id(input.to), text: text(input.text, 8192),
      createdAt: new Date().toISOString() };
    await this.agent(candidate.from); await this.agent(candidate.to);
    await this.checkLayout();
    const result = await this.publish(await this.folder('requests', true), candidate, isMessage);
    if (!sameMessage(result, candidate))
      fail('ID_CONFLICT', 'Request ID already belongs to a different message; retry with its original payload');
    // The canonical record reserves the ID globally. Retrying repairs a crash before inbox publication.
    const delivered = await this.publish(await this.folder('messages', true, result.to), result, isMessage);
    if (!sameMessage(delivered, result) || delivered.createdAt !== result.createdAt)
      fail('MAILBOX_CORRUPT', 'Inbox record does not match the canonical request');
    return result;
  }
  async messages(options: { agentId: string; cursor?: string; limit?: number; all?: boolean }) {
    await this.agent(options.agentId);
    const limit = pageLimit(options.limit);
    const cursor = options.cursor ?? '';
    if (cursor && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z_[0-9a-f-]{36}$/.test(cursor))
      fail('INVALID_PARAMS', 'Invalid message cursor; use nextCursor from a previous response');
    if (options.all !== undefined && typeof options.all !== 'boolean') fail('INVALID_PARAMS', 'all must be a boolean');
    await this.checkLayout();
    const inbox = await this.records('messages', isMessage, options.agentId);
    const requests = await this.folder('requests');
    for (let offset = 0; offset < inbox.length; offset += 8) {
      await Promise.all(inbox.slice(offset, offset + 8).map(async message => {
        const canonical = await this.read(requests, message.id, isMessage);
        if (!canonical || !sameMessage(message, canonical) || message.createdAt !== canonical.createdAt)
          fail('MAILBOX_CORRUPT', 'Inbox record does not match the canonical request');
      }));
    }
    const records = inbox.filter(message => {
      if (message.to !== options.agentId) fail('MAILBOX_CORRUPT', 'Message is stored in the wrong recipient inbox');
      return messageKey(message) > cursor;
    }).sort((a, b) => compare(messageKey(a), messageKey(b)));
    const folder = await this.folder('acks');
    const selected: (Message & { acknowledgedAt: string | null })[] = [];
    for (let offset = 0; offset < records.length; offset += 8) {
      const batch = records.slice(offset, offset + 8);
      const receipts = await Promise.all(batch.map(message => this.read(folder, message.id, isReceipt)));
      batch.forEach((message, index) => {
        const receipt = receipts[index];
        if (receipt && receipt.agentId !== message.to) fail('MAILBOX_CORRUPT', 'Receipt does not match message recipient');
        if (options.all || !receipt) selected.push({ ...message, acknowledgedAt: receipt?.acknowledgedAt ?? null });
      });
      if (selected.length > limit) break;
    }
    const messages = selected.slice(0, limit);
    const last = messages.at(-1);
    return { messages, nextCursor: selected.length > limit ? messageKey(last!) : null };
  }
  async getMessage(input: { id: string; agentId: string }): Promise<Message> {
    const messageId = id(input.id), agentId = id(input.agentId);
    await this.agent(agentId);
    await this.checkLayout();
    const message = await this.read(await this.folder('requests'), messageId, isMessage);
    if (!message) fail('MESSAGE_NOT_FOUND', 'Message does not exist');
    if (message.to !== agentId) fail('WRONG_RECIPIENT', 'Only the intended recipient can access this message');
    const delivered = await this.read(await this.folder('messages', false, agentId), messageId, isMessage);
    if (!delivered) fail('MESSAGE_NOT_DELIVERED', 'Retry the original send before using an incomplete delivery');
    if (!sameMessage(delivered, message) || delivered.createdAt !== message.createdAt)
      fail('MAILBOX_CORRUPT', 'Inbox record does not match the canonical request');
    return message;
  }
  async delivery(input: { id: string; agentId: string }): Promise<DeliveryState> {
    const message = await this.getMessage(input);
    // Read later stages first: a concurrent writer cannot make a legitimate earlier stage look missing.
    const completed = await this.read(await this.folder('delivery-completed'), message.id, isDeliveryCompleted);
    const started = await this.read(await this.folder('delivery-started'), message.id, isDeliveryStarted);
    const attempt = await this.read(await this.folder('delivery-attempts'), message.id, isDeliveryAttempt);
    if (!attempt) {
      if (started || completed) fail('MAILBOX_CORRUPT', 'Delivery stage exists without an attempt');
      return { id: message.id, agentId: message.to, stage: 'queued' };
    }
    if (attempt.agentId !== message.to) fail('MAILBOX_CORRUPT', 'Delivery owner does not match message recipient');
    for (const record of [started, completed]) {
      if (record && (record.agentId !== attempt.agentId || record.runId !== attempt.runId))
        fail('MAILBOX_CORRUPT', 'Delivery stage does not match its attempt owner');
    }
    if (completed && (!started || completed.turnId !== started.turnId))
      fail('MAILBOX_CORRUPT', 'Completion does not match a started turn');
    if (started && completed) return { ...attempt, ...started, ...completed, stage: 'turn_completed' };
    if (started) return { ...attempt, ...started, stage: 'turn_started' };
    return { ...attempt, stage: 'submission_unknown' };
  }

  async beginDelivery(input: { id: string; agentId: string; runId: string; threadId: string; windowId: string }): Promise<DeliveryState> {
    const candidate: DeliveryAttempt = { id: id(input.id), agentId: id(input.agentId), runId: id(input.runId),
      threadId: id(input.threadId), windowId: id(input.windowId), attemptedAt: new Date().toISOString() };
    await this.delivery(candidate);
    const stored = await this.publish(await this.folder('delivery-attempts', true), candidate, isDeliveryAttempt);
    if (stored.agentId !== candidate.agentId) fail('MAILBOX_CORRUPT', 'Delivery owner does not match message recipient');
    if (stored.runId !== candidate.runId || stored.threadId !== candidate.threadId || stored.windowId !== candidate.windowId)
      fail('DELIVERY_CONFLICT', 'Message already has an immutable delivery attempt owned by another run');
    return this.delivery(candidate);
  }
  async markDeliveryStarted(input: { id: string; agentId: string; runId: string; turnId: string }): Promise<DeliveryState> {
    const candidate: DeliveryStarted = { id: id(input.id), agentId: id(input.agentId), runId: id(input.runId),
      turnId: turnId(input.turnId), startedAt: new Date().toISOString() };
    const state = await this.delivery(candidate);
    if (state.stage === 'queued') fail('DELIVERY_NOT_STARTED', 'Persist a delivery attempt before recording turn start');
    if (state.runId !== candidate.runId) fail('DELIVERY_CONFLICT', 'Turn belongs to another delivery owner');
    const stored = await this.publish(await this.folder('delivery-started', true), candidate, isDeliveryStarted);
    if (stored.agentId !== candidate.agentId || stored.runId !== candidate.runId || stored.turnId !== candidate.turnId)
      fail('DELIVERY_CONFLICT', 'Message is already bound to another turn');
    return this.delivery(candidate);
  }
  async markDeliveryCompleted(input: { id: string; agentId: string; runId: string; turnId: string; status: DeliveryStatus }): Promise<DeliveryState> {
    if (!isDeliveryStatus(input.status)) fail('INVALID_PARAMS', 'Invalid turn completion status');
    const candidate: DeliveryCompleted = { id: id(input.id), agentId: id(input.agentId), runId: id(input.runId),
      turnId: turnId(input.turnId), status: input.status, completedAt: new Date().toISOString() };
    const state = await this.delivery(candidate);
    if (state.stage === 'queued' || state.stage === 'submission_unknown')
      fail('DELIVERY_NOT_STARTED', 'Persist turn start before recording completion');
    if (state.runId !== candidate.runId || state.turnId !== candidate.turnId)
      fail('DELIVERY_CONFLICT', 'Completion belongs to another owner or turn');
    const stored = await this.publish(await this.folder('delivery-completed', true), candidate, isDeliveryCompleted);
    if (stored.agentId !== candidate.agentId || stored.runId !== candidate.runId ||
      stored.turnId !== candidate.turnId || stored.status !== candidate.status)
      fail('DELIVERY_CONFLICT', 'Turn already has a different immutable completion');
    return this.delivery(candidate);
  }
  async ack(input: { id: string; agentId: string }): Promise<Receipt> {
    const messageId = id(input.id), agentId = id(input.agentId);
    await this.agent(agentId);
    await this.checkLayout();
    const message = await this.read(await this.folder('requests'), messageId, isMessage);
    if (!message) fail('MESSAGE_NOT_FOUND', 'Message does not exist');
    if (message.to !== agentId) fail('WRONG_RECIPIENT', 'Only the intended recipient can acknowledge this message');
    const delivered = await this.read(await this.folder('messages', false, agentId), messageId, isMessage);
    if (!delivered) fail('MESSAGE_NOT_DELIVERED', 'Retry the original send before acknowledging an incomplete delivery');
    if (!sameMessage(delivered, message) || delivered.createdAt !== message.createdAt)
      fail('MAILBOX_CORRUPT', 'Inbox record does not match the canonical request');
    const receipt = await this.publish(await this.folder('acks', true), {
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
