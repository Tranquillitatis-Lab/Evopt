import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent, Dataset } from '../src/types.ts';
import type { SWETask } from './import-swe.ts';
import { checkSWEHarness, evaluateSWE, type SWEHarnessOptions } from './swe-bench.ts';
import { execute } from './process.ts';

export type SWEInput = SWETask['input'];
export interface SWEManifest { version: 1; dataset: string; revision: string; datasetFile: string; datasetHash: string; tasks: SWETask[] }
export interface SWEDatasetOptions extends SWEHarnessOptions { evidenceDirectory: string; split?: string }
const gitOptions = ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'];
const git = (cwd: string, args: string[]) => execute('git', [...gitOptions, '-C', cwd, ...args], { timeoutMs: 120000, maxBytes: 32 * 1024 * 1024 });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, child: string) => { const path = relative(root, child); return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };

function validateInput(input: SWEInput): void {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'baseCommit,instanceId,problemStatement,repository'
    || !/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(input.instanceId) || !/^[a-f0-9]{40}$/.test(input.baseCommit)
    || typeof input.problemStatement !== 'string' || !input.problemStatement || !isAbsolute(input.repository)) throw new Error('Invalid SWE task input');
}

async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await physicalPath(dirname(path)), basename(path));
  }
}

async function sourceRepository(input: SWEInput): Promise<string> {
  const source = await realpath(input.repository);
  const bare = (await git(source, ['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true';
  const actual = (await git(source, ['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'])).stdout.trim();
  if (await realpath(actual) !== source || (await git(source, ['cat-file', '-t', input.baseCommit])).stdout.trim() !== 'commit') throw new Error('SWE source must be its Git root and contain the pinned commit');
  return source;
}

/** Wrap an existing agent with a new base-commit workspace for each invocation. */
export function createSWEAgent(agent: Agent<SWEInput, string>, options: { workspaceRoot: string }): Agent<SWEInput, string> {
  if (!isAbsolute(options.workspaceRoot)) throw new Error('SWE workspaceRoot must be absolute');
  return { ...agent, async run({ input, components, context }) {
    validateInput(input); context.signal.throwIfAborted();
    const source = await sourceRepository(input);
    const requestedRoot = await physicalPath(resolve(options.workspaceRoot));
    if (requestedRoot === source || inside(source, requestedRoot)) throw new Error('SWE workspaces must be outside the source repository');
    await mkdir(requestedRoot, { recursive: true });
    const root = await realpath(requestedRoot);
    if (root === source || inside(source, root)) throw new Error('SWE workspaces must be outside the source repository');
    const workspace = await mkdtemp(join(root, 'swe-'));
    try {
      await git(workspace, ['init', '--quiet', '--template=', '.']);
      await git(workspace, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', source, input.baseCommit]);
      await git(workspace, ['checkout', '--quiet', '--detach', input.baseCommit, '--']);
      if ((await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim() !== input.baseCommit) throw new Error('Workspace differs from the pinned base');
      context.signal.throwIfAborted();
      const result = await agent.run({ input: { ...input, repository: workspace }, components, context });
      context.signal.throwIfAborted();
      await git(workspace, ['add', '-A', '--', '.']);
      const patch = await git(workspace, ['diff', '--cached', '--binary', input.baseCommit, '--']);
      return { ...result, output: patch.stdout };
    } finally {
      if (!inside(root, resolve(workspace))) throw new Error('Unsafe workspace cleanup path');
      await rm(workspace, { recursive: true, force: true });
    }
  } };
}

/** Bind the sanitized task manifest to the local official grading harness. */
export async function createSWEDataset(manifest: SWEManifest, options: SWEDatasetOptions): Promise<Dataset<SWEInput, string>> {
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.revision) || !/^[a-f0-9]{64}$/.test(manifest.datasetHash)
    || !isAbsolute(manifest.datasetFile) || !isAbsolute(options.evidenceDirectory)) throw new Error('Invalid pinned SWE manifest or evidence directory');
  const bytes = await readFile(manifest.datasetFile);
  if (sha256(bytes) !== manifest.datasetHash) throw new Error('SWE dataset source hash changed');
  const source: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(source)) throw new Error('SWE dataset source must be an array');
  const sourceRows = new Map<string, { instance_id: string; repo: string; base_commit: string; problem_statement: string }>();
  for (const row of source) {
    if (!row || typeof row.instance_id !== 'string' || sourceRows.has(row.instance_id)) throw new Error('Invalid or duplicate SWE source row');
    sourceRows.set(row.instance_id, row);
  }
  const ids = new Set<string>(), byId = new Map<string, SWETask>();
  for (const task of manifest.tasks) {
    validateInput(task.input);
    if (task.id !== task.input.instanceId || task.expected !== task.id || ids.has(task.id) || !['train', 'gate', 'test'].includes(task.split)) throw new Error('Invalid SWE task identity or partition');
    const sourceRow = sourceRows.get(task.id);
    if (!sourceRow || sourceRow.problem_statement !== task.input.problemStatement || sourceRow.base_commit !== task.input.baseCommit
      || typeof sourceRow.repo !== 'string' || basename(task.input.repository) !== sourceRow.repo.replace('/', '__')) throw new Error('SWE manifest task differs from its pinned source');
    ids.add(task.id); byId.set(task.id, structuredClone(task));
  }
  if (!['train', 'gate', 'test'].every(split => manifest.tasks.some(task => task.split === split))) throw new Error('SWE partitions must be nonempty');
  await checkSWEHarness(options);
  const checked = new Set<string>();
  for (const task of manifest.tasks) {
    const key = `${task.input.repository}\0${task.input.baseCommit}`;
    if (!checked.has(key)) { await sourceRepository(task.input); checked.add(key); }
  }
  const tasks = (split: string) => manifest.tasks.filter(task => task.split === split).map(task => ({ id: task.id, input: structuredClone(task.input), expected: task.expected }));
  return { id: manifest.dataset, version: `${manifest.revision}:${manifest.datasetHash}:${options.revision}`,
    train: tasks('train'), validation: tasks('gate'), test: tasks('test'),
    async score({ input, output, expected }) {
      const task = byId.get(expected);
      validateInput(input);
      if (!task || (Object.keys(task.input) as (keyof SWEInput)[]).some(key => task.input[key] !== input[key]) || typeof output !== 'string') throw new Error('SWE scorer request differs from the prepared manifest');
      if (sha256(await readFile(manifest.datasetFile)) !== manifest.datasetHash) throw new Error('SWE dataset source hash changed');
      await mkdir(options.evidenceDirectory, { recursive: true });
      const directory = await mkdtemp(join(options.evidenceDirectory, 'grade-'));
      const predictions = join(directory, 'predictions.jsonl'), runId = `evopt-${randomUUID()}`;
      await writeFile(predictions, JSON.stringify({ instance_id: task.id, model_name_or_path: 'evopt', model_patch: output }) + '\n', { flag: 'wx', mode: 0o600 });
      const graded = await evaluateSWE(options, { predictions, dataset: manifest.datasetFile, split: options.split ?? 'test', instanceIds: [task.id], runId, outDir: directory });
      const report = graded.result as { resolved_ids?: unknown; unresolved_ids?: unknown; empty_patch_ids?: unknown; infra_failure_ids?: string[]; error_ids?: string[]; incomplete_ids?: string[]; ambiguous_failure_ids?: string[] };
      if (!Array.isArray(report.resolved_ids) || !Array.isArray(report.unresolved_ids)
        || (report.empty_patch_ids !== undefined && !Array.isArray(report.empty_patch_ids))
        || [...(report.infra_failure_ids ?? []), ...(report.error_ids ?? []), ...(report.incomplete_ids ?? []), ...(report.ambiguous_failure_ids ?? [])].includes(task.id)) throw new Error('SWE grading did not return a complete task outcome');
      const empty = (report.empty_patch_ids ?? []) as unknown[];
      const resolved = report.resolved_ids.includes(task.id), unresolved = report.unresolved_ids.includes(task.id), emptyPatch = empty.includes(task.id);
      if (Number(resolved) + Number(unresolved) + Number(emptyPatch) !== 1 || report.resolved_ids.length + report.unresolved_ids.length + empty.length !== 1) throw new Error('SWE grading returned an ambiguous task outcome');
      return resolved;
    } };
}
