import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineAgent } from '../src/optimize.js';
import type { Agent, Components, InvocationResult, RunContext } from '../src/types.js';
import { assert, clone, record } from '../src/validation.js';
import { runProcess } from './harness.js';
import { validateSWEInput, validateSWEManifest, type SWEInput, type SWEManifest } from './import-swe.js';

export type SWEAgentOptions = Omit<Agent<SWEInput, string>, 'run'> & {
  workspaceRoot: string;
  run(args: { input: SWEInput; components: Components; context: RunContext; workspace: string }): Promise<InvocationResult<string>>;
};
const gitSettings = ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
  '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'];
const git = (cwd: string, args: string[], timeoutMs = 30_000) => runProcess('git', [...gitSettings, ...args], { cwd, timeoutMs, maxBytes: 16 * 1024 * 1024 });
const inside = (root: string, child: string): boolean => {
  const path = relative(root, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
async function verifyRepository(input: SWEInput): Promise<string> {
  validateSWEInput(input);
  const root = await realpath(input.repository);
  assert((await stat(root)).isDirectory(), 'SWE-bench repository must be a local directory');
  const bare = (await git(root, ['rev-parse', '--is-bare-repository'])).stdout.trim();
  const actual = (await git(root, ['rev-parse', bare === 'true' ? '--absolute-git-dir' : '--show-toplevel'])).stdout.trim();
  assert(await realpath(actual) === root, 'SWE-bench repository must be its Git root');
  const type = (await git(root, ['cat-file', '-t', input.baseCommit])).stdout.trim();
  assert(type === 'commit', 'SWE-bench base object must be a commit');
  return root;
}

/** Check all locally provisioned bases before paid target evaluation. Never fetch remotely. */
export async function verifySWERepositories(manifest: SWEManifest): Promise<void> {
  validateSWEManifest(manifest);
  const checked = new Set<string>();
  for (const split of ['train', 'validation', 'test'] as const) for (const task of manifest.partitions[split]) {
    const key = JSON.stringify([task.input.repository, task.input.baseCommit]);
    if (!checked.has(key)) { await verifyRepository(task.input); checked.add(key); }
  }
}

// Resolve the existing parent before creating directories so symlinked workspace
// roots cannot accidentally write inside the user's source repository.
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await physicalPath(dirname(path)), relative(dirname(path), path));
  }
}

/** Existing agent callback, fresh pinned workspace, and its unchanged accounting contract. */
export function createSWEAgent(options: SWEAgentOptions): Agent<SWEInput, string> {
  assert(record(options), 'Missing SWE-bench agent options');
  assert(typeof options.workspaceRoot === 'string' && isAbsolute(options.workspaceRoot) && !options.workspaceRoot.includes('\0'), 'Use an absolute SWE-bench workspace root');
  assert(typeof options.run === 'function', 'Missing SWE-bench agent callback');
  const { workspaceRoot, run, ...agent } = options;
  return defineAgent({ ...agent, async run({ input, components, context }) {
    context.signal.throwIfAborted();
    const source = await verifyRepository(input); context.signal.throwIfAborted();
    const root = await physicalPath(resolve(workspaceRoot));
    assert(!inside(source, root), 'SWE-bench workspaces must be outside their source repository');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'swe-')); context.signal.throwIfAborted();
    // Empty init + shallow local fetch exposes only the requested base, without
    // hardlinks, source mutation, future solution commits, or inherited remotes.
    await git(workspace, ['init', '--quiet', '--template=', '.']); context.signal.throwIfAborted();
    await git(workspace, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', source, input.baseCommit], 120_000); context.signal.throwIfAborted();
    await git(workspace, ['checkout', '--quiet', '--detach', input.baseCommit, '--'], 120_000); context.signal.throwIfAborted();
    const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
    assert(head === input.baseCommit, 'SWE-bench workspace differs from its pinned base');
    context.signal.throwIfAborted();
    // The application's callback owns its model/tool calls and receipt accuracy.
    return run({ input: clone(input), components, context, workspace });
  } });
}

/** Explicit opt-in patch collection, including new nonignored files. No coding CLI is run. */
export async function collectSWEPatch(workspace: string, baseCommit?: string): Promise<string> {
  assert(typeof workspace === 'string' && isAbsolute(workspace) && !workspace.includes('\0'), 'Use an absolute SWE-bench workspace');
  const root = await realpath(workspace);
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  assert(await realpath(top) === root, 'Patch collection requires the workspace Git root');
  const base = baseCommit ?? (await git(root, ['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
  assert(typeof base === 'string' && /^[a-f0-9]{40}$/.test(base), 'Pin the full SWE-bench patch base commit');
  await git(root, ['add', '-A', '--', '.']);
  return (await git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', base, '--'])).stdout;
}
