import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize, createOfflineProposer, buildSubmission } from 'evopt';
import { prepareSWE, createSWEDataset, createSWEAgent, collectSWEPatch, type SWEInput } from 'evopt/benchmarks';
import { createFakeSWEHarness } from './fixtures/swe-harness.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/benchmark.mjs', import.meta.url));
const command = (...args: string[]) => exec(process.execPath, [cli, ...args], { timeout: 30_000 });
const groups = { train: ['fixture__app-1'], validation: ['fixture__app-2'], test: ['fixture__app-3'] };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'evopt-swe-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repos'), repository = join(repositoryRoot, 'fixture__app');
  await mkdir(repository, { recursive: true });
  await exec('git', ['init', '--quiet', repository]);
  await writeFile(join(repository, 'answer.txt'), 'original\n');
  await exec('git', ['-C', repository, 'add', 'answer.txt']);
  const name = (await exec('git', ['config', 'user.name'])).stdout.trim();
  const email = (await exec('git', ['config', 'user.email'])).stdout.trim();
  await exec('git', ['-C', repository, '-c', 'core.hooksPath=', '-c', `user.name=${name}`, '-c', `user.email=${email}`,
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Add benchmark fixture base']);
  const base = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const sourceFile = join(root, 'rows.json');
  const rows = [1, 2, 3].map(id => ({ instance_id: `fixture__app-${id}`, repo: 'fixture/app', base_commit: base,
    problem_statement: `Fix fixture issue ${id}`, image: 'evopt-fixture:local', version: 'fixture',
    patch: 'gold-do-not-leak', test_patch: 'test-do-not-leak', hints_text: 'hint-do-not-leak',
    FAIL_TO_PASS: '["private-failing-test"]', PASS_TO_PASS: '["private-passing-test"]' }));
  const bytes = JSON.stringify(rows);
  await writeFile(sourceFile, bytes);
  const options = { sourceFile, sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceRevision: 'a'.repeat(40),
    dataset: 'SWE-bench/SWE-bench_Lite', sourceSplit: 'test', repositoryRoot, groups };
  return { root, repository, options };
}

test('SWE CLI prepares the OPS-GA-style split manifest without reference solutions', async t => {
  const f = await fixture(t), splits = join(f.root, 'splits.json'), manifest = join(f.root, 'manifest.json');
  await writeFile(splits, JSON.stringify(groups));
  const args = ['prepare', '--benchmark', 'swe-bench', '--source', f.options.sourceFile, '--sha256', f.options.sourceSha256,
    '--revision', f.options.sourceRevision, '--dataset', f.options.dataset, '--source-split', 'test',
    '--repositories', f.options.repositoryRoot, '--splits', splits, '--out', manifest];
  const summary = JSON.parse((await command(...args)).stdout);
  assert.equal(summary.benchmark, 'swe-bench'); assert.equal(summary.inferenceRun, false);
  assert.deepEqual(summary.cases, { train: 1, validation: 1, test: 1 });
  const serialized = await readFile(manifest, 'utf8'), prepared = JSON.parse(serialized);
  for (const secret of ['gold-do-not-leak', 'test-do-not-leak', 'hint-do-not-leak', 'private-failing-test', 'private-passing-test', f.options.sourceFile]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(prepared.partitions.train[0].expected, groups.train[0]);
  await assert.rejects(command(...args), error => /EEXIST|exist/i.test((error as Error & { stderr: string }).stderr));
  await assert.rejects(command('evaluate', '--manifest', manifest, '--instance', 'fixture__app-99'),
    error => /outside the prepared manifest/.test((error as Error & { stderr: string }).stderr));
});

test('SWE optimization connects fresh general-agent workspaces to official-shaped grading and portable evidence', async t => {
  let python: string;
  try { python = (await exec('python', ['-c', 'import sys; print(sys.executable)'])).stdout.trim(); }
  catch { t.skip('Python required for the local evaluator fixture'); return; }
  const f = await fixture(t), manifest = await prepareSWE(f.options);
  const harness = await createFakeSWEHarness(join(f.root, 'harness-fixture'), python);
  const evaluator = { ...harness, evidenceDirectory: join(f.root, 'grading'), datasetFile: f.options.sourceFile };
  const dataset = await createSWEDataset(manifest, evaluator);
  const seen = new Set<string>();
  const agent = createSWEAgent({ id: 'swe-fixture-agent', version: '1', workspaceRoot: join(f.root, 'workspaces'),
    components: { systemPrompt: 'baseline' }, mutable: { systemPrompt: { role: 'Repair guidance', maxLength: 100 } },
    accounting: { kind: 'free', timeoutMs: 30_000 },
    optimization: { proposer: createOfflineProposer<SWEInput, string>([{ systemPrompt: 'improved' }]), maxAttempts: 1 },
    async run({ input, components, context, workspace }) {
      assert.equal(seen.has(workspace), false); seen.add(workspace);
      assert.equal(await readFile(join(workspace, 'answer.txt'), 'utf8'), 'original\n');
      assert.equal((await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim(), input.baseCommit);
      assert.deepEqual(Object.keys(input).sort(), ['baseCommit', 'instanceId', 'problemStatement', 'repo', 'repository']);
      assert.equal(JSON.stringify(input).includes('do-not-leak'), false);
      assert.equal(context.signal.aborted, false);
      await writeFile(join(workspace, 'answer.txt'), components.systemPrompt === 'improved' ? 'fixture-pass\n' : 'bad repair\n');
      return { output: await collectSWEPatch(workspace, input.baseCommit), usage: { complete: true, receipts: [] } };
    },
  });
  const result = await optimize({ agent, dataset, objective: 'accuracy', budget: 1, run: { directory: join(f.root, 'optimization') } });
  assert.equal(result.status, 'completed', result.reason ?? 'SWE workflow did not complete');
  assert.equal(result.components.systemPrompt, 'improved');
  assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 0, candidateAccuracy: 1 });
  assert.equal(seen.size, result.evaluations.length);
  assert.equal(await readFile(join(f.repository, 'answer.txt'), 'utf8'), 'original\n');
  const submission = buildSubmission(result, { id: 'swe-fixture', summary: 'Synthetic SWE adapter integration test', reviewed: true });
  assert.equal(submission.provenance.synthetic, true);
  assert.equal(submission.provenance.benchmark?.id, 'SWE-bench/SWE-bench_Lite');
  assert.equal(submission.provenance.benchmark?.sourceSha256, f.options.sourceSha256);
  assert.ok((await readdir(evaluator.evidenceDirectory)).length >= result.evaluations.length);
  await writeFile(f.options.sourceFile, '[]');
  await assert.rejects(createSWEDataset(manifest, evaluator), /SHA|hash|digest|changed|match/i);
});
