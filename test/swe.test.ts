import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importSWE } from '../benchmarks/import-swe.ts';
import { createSWEAgent, createSWEDataset } from '../benchmarks/swe-adapter.ts';
import { execute } from '../benchmarks/process.ts';
import type { Agent } from '../src/types.ts';

test('SWE source projection, fresh base workspaces, and local official-shaped grading', async t => {
  let python: string;
  try { python = (await execute('python', ['-c', 'import sys; print(sys.executable)'])).stdout.trim(); }
  catch { t.skip('Python is required for the fake local evaluator'); return; }
  const root = await mkdtemp(join(tmpdir(), 'evopt-swe-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'repositories', 'owner__repo'); await mkdir(source, { recursive: true });
  await execute('git', ['-C', source, 'init', '--quiet']);
  await execute('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  await execute('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(source, 'file.txt'), 'baseline\n');
  await execute('git', ['-C', source, 'add', 'file.txt']);
  await execute('git', ['-C', source, 'commit', '--quiet', '-m', 'fixture']);
  const baseCommit = (await execute('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const rows = ['train', 'gate', 'test'].map(name => ({ instance_id: `owner__${name}`, repo: 'owner/repo', base_commit: baseCommit,
    problem_statement: `Repair ${name}`, patch: 'PRIVATE GOLD PATCH', test_patch: 'PRIVATE HIDDEN TEST' }));
  const datasetFile = join(root, 'dataset.json'), manifestFile = join(root, 'manifest.json');
  await writeFile(datasetFile, JSON.stringify(rows));
  const { manifest } = await importSWE(datasetFile, manifestFile, { dataset: 'SWE-bench/SWE-bench_Lite', revision: 'a'.repeat(40),
    repositoryRoot: join(root, 'repositories'), groups: { train: ['owner__train'], gate: ['owner__gate'], test: ['owner__test'] } });
  const serialized = await readFile(manifestFile, 'utf8');
  assert.equal(serialized.includes('PRIVATE GOLD PATCH'), false); assert.equal(serialized.includes('PRIVATE HIDDEN TEST'), false);
  const harness = join(root, 'harness'); await mkdir(join(harness, 'swebench', 'harness'), { recursive: true });
  await writeFile(join(harness, '.gitignore'), 'logs/\n__pycache__/\n*.pyc\n');
  await writeFile(join(harness, 'swebench', '__init__.py'), '');
  await writeFile(join(harness, 'swebench', 'harness', '__init__.py'), '');
  await writeFile(join(harness, 'swebench', 'harness', 'run_evaluation.py'), `import argparse, json, pathlib\np=argparse.ArgumentParser()\np.add_argument('--dataset_name');p.add_argument('--split');p.add_argument('--predictions_path');p.add_argument('--run_id');p.add_argument('--max_workers');p.add_argument('--instance_ids',nargs='+')\na=p.parse_args()\nr=pathlib.Path('logs/evaluation')/a.run_id;r.mkdir(parents=True)\nprediction=json.loads(pathlib.Path(a.predictions_path).read_text())\nempty=not prediction['model_patch']\n(r/'results.json').write_text(json.dumps({'resolved_ids':[] if empty else a.instance_ids,'unresolved_ids':[],'empty_patch_ids':a.instance_ids if empty else []}))\n`);
  await execute('git', ['-C', harness, 'init', '--quiet']);
  await execute('git', ['-C', harness, 'config', 'user.name', 'Fixture']);
  await execute('git', ['-C', harness, 'config', 'user.email', 'fixture@example.invalid']);
  await execute('git', ['-C', harness, 'add', '.']);
  await execute('git', ['-C', harness, 'commit', '--quiet', '-m', 'harness fixture']);
  const revision = (await execute('git', ['-C', harness, 'rev-parse', 'HEAD'])).stdout.trim();
  const dataset = await createSWEDataset(manifest, { python, harnessCwd: harness, revision, evidenceDirectory: join(root, 'evidence') });
  const altered = structuredClone(manifest);
  Object.assign(altered.tasks[0]!.input, { test_patch: 'hidden' });
  await assert.rejects(() => createSWEDataset(altered, { python, harnessCwd: harness, revision, evidenceDirectory: join(root, 'evidence') }), /Invalid SWE task input/);
  const seen: string[] = [];
  const agent: Agent<typeof dataset.train[number]['input'], string> = {
    id: 'fixture', version: '1', components: { prompt: 'Repair.' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } },
    accounting: { kind: 'free', timeoutMs: 1000 },
    optimization: { proposer: { id: 'fixture', version: '1', accounting: { kind: 'free', timeoutMs: 1000 },
      async propose() { return { output: {}, usage: { complete: true, receipts: [] } }; } } },
    async run({ input }) {
      seen.push(input.repository); assert.notEqual(input.repository, source);
      assert.equal(await readFile(join(input.repository, 'file.txt'), 'utf8'), 'baseline\n');
      assert.equal(JSON.stringify(input).includes('PRIVATE'), false);
      await writeFile(join(input.repository, 'file.txt'), 'fixed\n');
      return { output: 'done', usage: { complete: true, receipts: [] } };
    } };
  const isolated = createSWEAgent(agent, { workspaceRoot: join(root, 'workspaces') });
  const task = dataset.train[0]!, context = { signal: new AbortController().signal, evaluationId: 'one' };
  const unsafeRoot = join(source, 'not-created');
  await assert.rejects(() => createSWEAgent(agent, { workspaceRoot: unsafeRoot }).run({ input: task.input, components: agent.components, context }), /outside the source repository/);
  await assert.rejects(stat(unsafeRoot), /ENOENT/);
  const first = await isolated.run({ input: task.input, components: agent.components, context });
  const second = await isolated.run({ input: task.input, components: agent.components, context: { ...context, evaluationId: 'two' } });
  assert.match(first.output, /\+fixed/); assert.equal(first.output, second.output); assert.notEqual(seen[0], seen[1]);
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'baseline\n');
  await assert.rejects(readFile(join(seen[0]!, 'file.txt')), /ENOENT/);
  assert.equal(await dataset.score({ input: task.input, output: first.output, expected: task.expected }), true);
  assert.equal(await dataset.score({ input: task.input, output: '', expected: task.expected }), false);
  await writeFile(datasetFile, '[]');
  await assert.rejects(async () => dataset.score({ input: task.input, output: first.output, expected: task.expected }), /hash changed/);
});
