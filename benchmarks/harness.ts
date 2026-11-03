import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface HarnessPin {
  /** Explicit local Python executable; never a shell command. */
  python: string;
  /** Root of the reviewed evaluator Git checkout. */
  cwd: string;
  /** Exact 40-character commit id. */
  revision: string;
  timeoutMs?: number;
}
export interface ProcessOptions { cwd: string; timeoutMs: number; maxBytes?: number }

/** Failed evaluator execution with the same bounded diagnostics as successful runs. */
export class ProcessFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, output: { stdout: string; stderr: string }, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProcessFailure';
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
}

/** Execute trusted evaluator tooling with fixed argv, bounded output, and no shell. */
export async function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<{ stdout: string; stderr: string }> {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('Invalid executable');
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('Invalid process arguments');
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error('Invalid process timeout');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid process output bound');
  return new Promise((fulfill, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, finished = false, failure: Error | undefined;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (error) reject(new ProcessFailure(error.message, output, { cause: error }));
      else fulfill(output);
    };
    const stop = (error: Error): void => {
      if (finished || failure) return;
      failure = error; clearTimeout(timer);
      // Trusted evaluator processes must not spawn detached/background work.
      // Close inherited pipes, then await child close before releasing its cwd.
      child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(new Error('Evaluator process timed out')), options.timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (finished || failure) return;
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        bytes = maxBytes;
        stop(new Error('Evaluator process exceeded its output bound'));
      } else {
        bytes += chunk.length;
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', error => stop(error));
    child.on('close', (code, signal) => finish(failure ?? (code === 0 ? undefined : new Error(`Evaluator process failed (${signal ?? code ?? 'unknown exit'})`))));
  });
}

const nulRows = (value: string): string[] => value.split('\0').filter(Boolean);
const inside = (root: string, child: string): boolean => {
  const path = relative(root, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const cacheFile = (path: string): boolean => /(?:^|\/)__pycache__\/[^/]+\.pyc$/.test(path);

/**
 * Verify a locally provisioned evaluator before inference or grading. This never
 * clones, installs dependencies, runs inference, or executes candidate commands.
 * The checkout and Python environment remain reviewed trusted infrastructure.
 */
export async function verifyHarness(pin: HarnessPin, subdirectory = 'swebench'): Promise<{ revision: string }> {
  if (!pin || typeof pin.python !== 'string' || !isAbsolute(pin.python) || !(await stat(pin.python)).isFile()) {
    throw new Error('Pin an existing absolute Python executable');
  }
  if (typeof pin.cwd !== 'string' || !isAbsolute(pin.cwd)) throw new Error('Pin an absolute evaluator checkout root');
  if (!/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error('Pin the exact evaluator Git commit');
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(subdirectory)) throw new Error('Unsafe evaluator subdirectory');
  const root = await realpath(pin.cwd), evaluator = await realpath(resolve(root, subdirectory));
  if (!inside(root, evaluator) || !(await stat(evaluator)).isDirectory()) throw new Error('Evaluator must be a directory inside its checkout');
  const options = { cwd: root, timeoutMs: pin.timeoutMs ?? 30_000, maxBytes: 8 * 1024 * 1024 };
  const git = (args: string[]) => runProcess('git', ['--literal-pathspecs', ...args], options);
  const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if (await realpath(top) !== root) throw new Error('Evaluator cwd must be its Git checkout root');
  const actual = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  if (actual !== pin.revision) throw new Error('Evaluator checkout differs from its pinned revision');
  const changes = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', subdirectory])).stdout;
  if (changes) throw new Error('Tracked evaluator files must be unmodified');
  const tracked = nulRows((await git(['ls-files', '--stage', '-z', '--', subdirectory])).stdout);
  if (tracked.length === 0) throw new Error('Evaluator directory has no tracked source');
  for (const entry of tracked) {
    const match = /^(\d+) [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1]!)) throw new Error('Evaluator links, submodules, or unresolved entries are unsupported');
    const file = resolve(root, match[2]!);
    if (!inside(root, file) || !inside(root, await realpath(file))) throw new Error('Evaluator source escapes its checkout');
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Evaluator source links are unsupported');
  }
  const untracked = nulRows((await git(['ls-files', '--others', '--exclude-standard', '-z', '--', subdirectory])).stdout);
  if (untracked.some(file => !cacheFile(file))) throw new Error('Untracked evaluator files are unsupported');
  const ignored = nulRows((await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', subdirectory])).stdout);
  if (ignored.some(file => !cacheFile(file) && /\.(?:py|pyc|pyo|pyd|so|dll)$/i.test(file))) throw new Error('Ignored evaluator source is unsupported');
  return { revision: actual };
}
