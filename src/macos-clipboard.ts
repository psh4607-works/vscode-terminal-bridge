import { execFile } from 'node:child_process';
import path from 'node:path';
import { lstat, unlink, rmdir } from 'node:fs/promises';

export type MacClipboard = { kind: 'files' | 'image'; paths: string[]; discard?: () => Promise<void> } | { kind: 'text' };
type Runner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; shell: false }) => Promise<string>;
const run: Runner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => {
    if (error) reject(new Error('Unable to read macOS clipboard.'));
    else resolve(stdout);
  });
});

export async function readMacClipboardWithRunner(runner: Runner, directory?: string): Promise<MacClipboard> {
  const output = await runner('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, '../resources/clipboard.js'), directory ?? ''], { timeout: 10000, maxBuffer: 1024 * 1024, shell: false });
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('Invalid clipboard response.'); }
  const result = value as Record<string, unknown> | null;
  if (result?.kind === 'text') return { kind: 'text' };
  if (!result || (result.kind !== 'files' && result.kind !== 'image') || !Array.isArray(result.paths) || result.paths.length === 0 || result.paths.length > 1000 || result.paths.some(p => typeof p !== 'string' || !path.posix.isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p))) {
    throw new Error('Invalid clipboard paths.');
  }
  return { kind: result.kind, paths: result.paths as string[] };
}

export function attachClipboardDiscard(content: MacClipboard): MacClipboard {
  if (content.kind !== 'image' || content.paths.length !== 1) return content;
  const image = content.paths[0];
  const folder = path.dirname(image);
  if (path.basename(image) !== 'image.png' || !/^vscode-terminal-paste-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(path.basename(folder))) return content;
  return { ...content, discard: async () => {
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      await unlink(image);
      await rmdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to discard clipboard image.');
    }
  } };
}

export async function readMacClipboard(directory?: string): Promise<MacClipboard> {
  return attachClipboardDiscard(await readMacClipboardWithRunner(run, directory));
}
