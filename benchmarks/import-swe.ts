import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { assert, canonical, record, text } from '../src/validation.js';

export interface SWEInput {
  instanceId: string; repo: string; baseCommit: string; problemStatement: string; repository: string;
}
export interface SWETask { id: string; input: SWEInput; expected: string }
export interface SWEManifest {
  format: 1; id: 'swe-bench';
  source: { name: string; revision: string; sha256: string; url: string; split: string };
  metric: 'resolved'; splitPolicy: 'custom-disjoint';
  partitions: { train: SWETask[]; validation: SWETask[]; test: SWETask[] };
}
export interface PrepareSWEOptions {
  sourceFile: string; sourceSha256: string; sourceRevision: string;
  dataset: string; sourceSplit: string; repositoryRoot: string;
  groups: { train: string[]; validation: string[]; test: string[] };
}

const partitions = ['train', 'validation', 'test'] as const;
const officialDataset = /^(?:SWE-bench|princeton-nlp)\/SWE-bench(?:_Lite|_Verified)?$/;
const commit = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const identity = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const repositoryName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const sourceURL = (name: string, revision: string) => `https://huggingface.co/datasets/${name}/tree/${revision}`;
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  assert(Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key)), 'Unexpected or missing SWE-bench fields');
}
function pin(value: unknown, pattern: RegExp, description: string): asserts value is string {
  assert(typeof value === 'string' && pattern.test(value), description);
}
function validateSource(name: unknown, revision: unknown, sha256: unknown, split: unknown): void {
  pin(name, officialDataset, 'Only official SWE-bench, SWE-bench Lite, and SWE-bench Verified datasets are supported');
  pin(revision, commit, 'Pin the full dataset Git revision');
  pin(sha256, digest, 'Pin the raw source SHA-256');
  assert(typeof split === 'string' && ['train', 'dev', 'test'].includes(split), 'Declare the official source split (train, dev, or test)');
}

/** Target inputs are an allowlisted projection; verifier and solution fields never enter the manifest. */
export function validateSWEInput(value: unknown): asserts value is SWEInput {
  assert(record(value), 'Invalid SWE-bench input');
  keys(value, ['instanceId', 'repo', 'baseCommit', 'problemStatement', 'repository']);
  pin(value.instanceId, identity, 'Invalid SWE-bench instance id');
  pin(value.repo, repositoryName, 'Unsafe SWE-bench repository name');
  pin(value.baseCommit, commit, 'Pin the full SWE-bench base commit');
  text(value.problemStatement);
  assert(typeof value.repository === 'string' && isAbsolute(value.repository) && !value.repository.includes('\0'), 'Use an absolute local repository path');
  assert(basename(value.repository) === value.repo.replace('/', '__'), 'Repository path must end in owner__repo');
}

export function validateSWEManifest(value: unknown): asserts value is SWEManifest {
  assert(record(value), 'Invalid SWE-bench manifest');
  keys(value, ['format', 'id', 'source', 'metric', 'splitPolicy', 'partitions']);
  assert(value.format === 1 && value.id === 'swe-bench' && value.metric === 'resolved', 'Unsupported SWE-bench manifest');
  assert(value.splitPolicy === 'custom-disjoint', 'Declare custom disjoint SWE-bench partitions');
  assert(record(value.source), 'Missing pinned SWE-bench source');
  keys(value.source, ['name', 'revision', 'sha256', 'url', 'split']);
  validateSource(value.source.name, value.source.revision, value.source.sha256, value.source.split);
  assert(value.source.url === sourceURL(value.source.name as string, value.source.revision as string), 'SWE-bench source URL must match its dataset revision');
  assert(record(value.partitions), 'Missing SWE-bench partitions'); keys(value.partitions, partitions);
  const ids = new Set<string>();
  for (const split of partitions) {
    const tasks = value.partitions[split];
    assert(Array.isArray(tasks) && tasks.length > 0, 'SWE-bench partitions must be nonempty');
    for (const task of tasks) {
      assert(record(task), 'Malformed SWE-bench task'); keys(task, ['id', 'input', 'expected']);
      validateSWEInput(task.input);
      assert(task.id === task.input.instanceId && task.expected === task.id, 'SWE-bench task identity and expected label must match');
      assert(!ids.has(task.id), 'Duplicate or overlapping SWE-bench instance'); ids.add(task.id);
    }
  }
  canonical(value);
}

type SourceRow = { instance_id: string; repo: string; base_commit: string; problem_statement: string };
async function readSource(sourceFile: string, sourceSha256: string): Promise<Map<string, SourceRow>> {
  text(sourceFile); pin(sourceSha256, digest, 'Pin the raw source SHA-256');
  const bytes = await readFile(sourceFile);
  assert(createHash('sha256').update(bytes).digest('hex') === sourceSha256, 'SWE-bench source SHA-256 mismatch');
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  assert(body.length > 0, 'Empty SWE-bench source');
  const source: unknown = body.startsWith('[') ? JSON.parse(body) : body.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  assert(Array.isArray(source) && source.length > 0, 'Expected local SWE-bench JSON array or JSONL rows');
  const rows = new Map<string, SourceRow>();
  for (const value of source) {
    assert(record(value), 'Malformed SWE-bench source row');
    pin(value.instance_id, identity, 'Invalid SWE-bench source instance id');
    pin(value.repo, repositoryName, 'Unsafe SWE-bench repository name');
    pin(value.base_commit, commit, 'Pin the full SWE-bench base commit'); text(value.problem_statement);
    assert(!rows.has(value.instance_id), 'Duplicate SWE-bench source instance id');
    rows.set(value.instance_id, { instance_id: value.instance_id, repo: value.repo, base_commit: value.base_commit, problem_statement: value.problem_statement });
  }
  return rows;
}

/** Import a reviewed local export. This does not download datasets or provision repositories. */
export async function prepareSWE(options: PrepareSWEOptions): Promise<SWEManifest> {
  assert(record(options), 'Missing SWE-bench import options');
  validateSource(options.dataset, options.sourceRevision, options.sourceSha256, options.sourceSplit);
  assert(typeof options.repositoryRoot === 'string' && isAbsolute(options.repositoryRoot) && !options.repositoryRoot.includes('\0'), 'Use an absolute local repository root');
  assert(record(options.groups), 'Declare explicit disjoint SWE-bench groups'); keys(options.groups, partitions);
  const rows = await readSource(options.sourceFile, options.sourceSha256);
  const manifest: SWEManifest = { format: 1, id: 'swe-bench',
    source: { name: options.dataset, revision: options.sourceRevision, sha256: options.sourceSha256, url: sourceURL(options.dataset, options.sourceRevision), split: options.sourceSplit },
    metric: 'resolved', splitPolicy: 'custom-disjoint', partitions: { train: [], validation: [], test: [] } };
  const selected = new Set<string>();
  for (const split of partitions) {
    const ids = options.groups[split];
    assert(Array.isArray(ids) && ids.length > 0, 'SWE-bench groups must be nonempty');
    for (const id of ids) {
      pin(id, identity, 'Invalid requested SWE-bench instance id');
      assert(!selected.has(id), 'Overlapping SWE-bench groups'); selected.add(id);
      const row = rows.get(id); assert(row, `Missing SWE-bench instance ${id}`);
      manifest.partitions[split].push({ id, expected: id, input: { instanceId: id, repo: row.repo, baseCommit: row.base_commit,
        problemStatement: row.problem_statement, repository: join(resolve(options.repositoryRoot), row.repo.replace('/', '__')) } });
    }
  }
  validateSWEManifest(manifest); return manifest;
}

/** Bind every target-visible task back to the raw export before any paid inference. */
export async function assertSWESourceMatches(manifest: SWEManifest, sourceFile: string): Promise<void> {
  validateSWEManifest(manifest);
  const source = await readSource(sourceFile, manifest.source.sha256);
  for (const split of partitions) for (const task of manifest.partitions[split]) {
    const row = source.get(task.id), input = task.input;
    assert(row && row.instance_id === input.instanceId && row.repo === input.repo && row.base_commit === input.baseCommit && row.problem_statement === input.problemStatement,
      `SWE-bench manifest does not match pinned source instance ${task.id}`);
  }
}
