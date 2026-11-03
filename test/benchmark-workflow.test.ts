import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize, defineAgent, createOfflineProposer, exactMatch, buildSubmission, type Dataset, type BenchmarkProvenance } from 'evopt';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/benchmark.mjs', import.meta.url));
async function command(...args: string[]) { return execute(process.execPath, [cli, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }); }
async function temp(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'evopt-benchmark-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function rejection(args: string[], pattern: RegExp) {
  await assert.rejects(command(...args), error => { assert.match((error as Error & { stderr: string }).stderr, pattern); return true; });
}
test('benchmark catalog focuses on SWE and separates runnable adapters from assessed suites', async () => {
  const result = JSON.parse((await command('list')).stdout);
  assert.deepEqual(result.benchmarks.filter((b: any) => b.status === 'implemented').map((b: any) => b.id), ['swe-bench']);
  assert.equal(result.inferenceRun, false);
  for (const id of ['frontier-code', 'terminal-bench', 'swe-atlas-qna-aa']) {
    assert.equal(result.benchmarks.find((b: any) => b.id === id).status, 'not-implemented');
  }
  await rejection(['prepare', '--benchmark', 'terminal-bench'], /Only the SWE-bench importer/);
});
test('benchmark provenance survives optimization and export, binds resume, and never reaches targets', async t => {
  const benchmark: BenchmarkProvenance = { id: 'synthetic-workflow-fixture', sourceRevision: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
    metric: 'fixture-exact-match', splitPolicy: 'custom-disjoint', evaluator: { name: 'local-test-fixture', revision: 'd'.repeat(40) } };
  let calls = 0;
  const agent = defineAgent<string, string>({ id: 'fixture-agent', version: '1', components: { prompt: 'original' },
    mutable: { prompt: { role: 'Formatting instructions', maxLength: 100 } }, accounting: { kind: 'free', timeoutMs: 1000 },
    optimization: { proposer: createOfflineProposer<string, string>([{ prompt: 'lowercase' }]), maxAttempts: 1 },
    async run(args) {
      calls++;
      assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
      assert.deepEqual(Object.keys(args.context).sort(), ['evaluationId', 'signal']);
      assert.equal(JSON.stringify(args).includes(benchmark.sourceSha256), false);
      return { output: args.components.prompt === 'lowercase' ? args.input.toLowerCase() : args.input, usage: { complete: true, receipts: [] } };
    },
  });
  const dataset: Dataset<string, string> = { id: 'fixture-dataset', version: '1', benchmark, score: exactMatch,
    train: [{ id: 't', input: 'A', expected: 'a' }], validation: [{ id: 'v', input: 'B', expected: 'b' }], test: [{ id: 'h', input: 'C', expected: 'c' }] };
  const directory = join(await temp(t), 'run');
  const result = await optimize({ agent, dataset, objective: 'accuracy', budget: 1, run: { directory } });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.provenance.benchmark, benchmark);
  const submission = buildSubmission(result, { id: 'benchmark-fixture', summary: 'Synthetic provenance workflow test', reviewed: true });
  assert.deepEqual(submission.provenance.benchmark, benchmark);
  const before = calls;
  await assert.rejects(optimize({ agent, dataset: { ...dataset, benchmark: { ...benchmark, sourceRevision: 'e'.repeat(40) } }, objective: 'accuracy', budget: 1,
    run: { directory, resume: true } }), /fingerprint mismatch/);
  assert.equal(calls, before);
});
