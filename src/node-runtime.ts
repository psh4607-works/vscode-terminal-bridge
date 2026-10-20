import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';

function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }

export async function resolveNodeRuntime(value = 'node'): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || (value.includes(path.sep) && !path.isAbsolute(value)))
    throw failure('INVALID_PARAMS', 'Node executable must be an absolute path or a bare executable name');
  const candidates = path.isAbsolute(value) ? [value] : (process.env.PATH ?? '').split(path.delimiter)
    .filter(path.isAbsolute).map(folder => path.join(folder, value));
  let resolved: string | undefined;
  for (const candidate of candidates) {
    try {
      const actual = await fs.realpath(candidate);
      if (!(await fs.stat(actual)).isFile()) continue;
      await fs.access(actual, constants.X_OK);
      resolved = actual;
      break;
    } catch {}
  }
  if (!resolved) throw failure('NODE_EXECUTABLE_NOT_FOUND', 'Node executable was not found or is not executable');
  const output = await new Promise<string>((resolve, reject) => {
    execFile(resolved!, ['--version'], { timeout: 5000, maxBuffer: 1024, encoding: 'utf8', killSignal: 'SIGKILL', shell: false }, (error, stdout) => {
      if (error) reject(failure('NODE_RUNTIME_FAILED', 'Node version verification failed or exceeded its limits'));
      else resolve(stdout.trim());
    });
  });
  const version = /^v(\d+)\.\d+\.\d+$/.exec(output);
  if (!version) throw failure('NODE_RUNTIME_FAILED', 'Node returned an invalid version');
  if (!Number.isSafeInteger(Number(version[1])) || Number(version[1]) < 22)
    throw failure('NODE_VERSION_UNSUPPORTED', 'Node.js 22 or newer is required');
  return resolved;
}
