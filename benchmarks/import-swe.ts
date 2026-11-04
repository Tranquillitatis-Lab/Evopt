import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export interface SWETask {
  id: string; split: 'train' | 'gate' | 'test';
  input: { instanceId: string; problemStatement: string; baseCommit: string; repository: string };
  expected: string;
}
export interface SWEImportOptions { dataset: string; revision: string; repositoryRoot: string; groups: Record<'train' | 'gate' | 'test', string[]> }

/** Project public task fields from an explicitly prepared local dataset export. */
export async function importSWE(input: string, output: string, options: SWEImportOptions) {
  const bytes = await readFile(input), rows: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(rows) || !/^(?:SWE-bench|princeton-nlp)\/SWE-bench(?:_Lite|_Verified)?$/.test(options.dataset)
    || !/^[a-f0-9]{40}$/.test(options.revision)) throw new Error('Pin an official SWE-bench dataset and revision');
  const all = ['train', 'gate', 'test'].flatMap(split => options.groups[split as keyof typeof options.groups] ?? []);
  if (!all.length || new Set(all).size !== all.length || !['train', 'gate', 'test'].every(split => options.groups[split as keyof typeof options.groups]?.length)) throw new Error('Explicit nonempty disjoint instance groups are required');
  const seen = new Set<string>(), byId = new Map<string, any>();
  for (const row of rows) {
    if (!row || typeof row.instance_id !== 'string' || seen.has(row.instance_id)) throw new Error('Invalid or duplicate source instance');
    seen.add(row.instance_id); byId.set(row.instance_id, row);
  }
  const tasks: SWETask[] = [];
  for (const split of ['train', 'gate', 'test'] as const) for (const id of options.groups[split]) {
    const row = byId.get(id);
    if (!row || !/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(id) || typeof row.problem_statement !== 'string'
      || !/^[a-f0-9]{40}$/.test(row.base_commit) || typeof row.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repo)) throw new Error(`Invalid source task ${id}`);
    tasks.push({ id, split, input: { instanceId: id, problemStatement: row.problem_statement, baseCommit: row.base_commit,
      repository: resolve(join(options.repositoryRoot, row.repo.replace('/', '__'))) }, expected: id });
  }
  const manifest = { version: 1 as const, dataset: options.dataset, revision: options.revision, datasetFile: resolve(input),
    datasetHash: createHash('sha256').update(bytes).digest('hex'), tasks };
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { tasks: tasks.length, manifest, omittedFields: ['patch', 'test_patch', 'hints_text', 'FAIL_TO_PASS', 'PASS_TO_PASS'] };
}
