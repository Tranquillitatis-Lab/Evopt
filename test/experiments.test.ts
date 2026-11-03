import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent, createOfflineProposer, exactMatch } from 'evopt';
import { defineExperiment, checkExperiment, runExperiment } from '../src/experiments.js';
import type { Accounting, OptimizationResult } from 'evopt';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/experiment.mjs', import.meta.url));
async function temp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evopt-experiment-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function command(...args: string[]) {
  return execute(process.execPath, [cli, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}
async function rejection(args: string[], pattern: RegExp): Promise<void> {
  await assert.rejects(command(...args), error => {
    const e = error as Error & { stderr: string; code: number };
    assert.notEqual(e.code, 0); assert.match(e.stderr, pattern); return true;
  });
}
function experiment() {
  return defineExperiment({
    id: 'generic-text', description: 'Framework-independent offline fixture', objective: 'accuracy',
    agent: defineAgent<string, string>({
      id: 'text-agent', version: '1', components: { prompt: 'keep case' },
      mutable: { prompt: { role: 'Output format', maxLength: 40 } },
      accounting: { kind: 'free', timeoutMs: 1_000 },
      optimization: { proposer: createOfflineProposer<string, string>([{ prompt: 'lowercase' }]), maxAttempts: 1 },
      async run({ input, components }) {
        return { output: components.prompt === 'lowercase' ? input.toLowerCase() : input, usage: { complete: true, receipts: [] } };
      },
    }),
    dataset: { id: 'letters', version: '1', score: exactMatch,
      train: [{ id: 'train', input: 'A', expected: 'a' }],
      validation: [{ id: 'validation', input: 'B', expected: 'b' }],
      test: [{ id: 'test', input: 'C', expected: 'c' }],
    },
  });
}

test('experiment preflight calculates bounds without invoking paid target or proposer', async t => {
  const e = experiment(); let calls = 0;
  const paid: Accounting = {
    kind: 'paid', maxCostUSD: 0.01, version: '1', enforcement: 'Fixture enforces a single bounded request',
    pricing: { source: 'fixture', checkedAt: '2026-11-03', inputUSDPerMillion: 1000, outputUSDPerMillion: 1000 },
    limits: { maxModelCalls: 1, maxInputTokens: 5, maxOutputTokens: 5, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  };
  e.agent.accounting = paid;
  e.agent.optimization.proposer.accounting = paid;
  e.agent.run = async () => { calls++; throw new Error('Unexpected paid invocation'); };
  e.agent.optimization.proposer.propose = async () => { calls++; throw new Error('Unexpected paid proposal'); };
  const check = checkExperiment(e, 0.04);
  assert.equal(check.paid, true); assert.equal(check.inferenceRun, false);
  assert.equal(check.minimumMicros, 40_000); assert.equal(check.plannedMaximumMicros, 70_000);
  assert.equal(check.minimumFits, true); assert.equal(check.plannedFits, false);
  await assert.rejects(runExperiment(e, { budget: 1, directory: join(await temp(t), 'run') }), /allow-paid/);
  assert.equal(calls, 0);
});

test('contributor scaffold runs offline outside the repository and exports reviewable evidence', async t => {
  const root = await temp(t), config = join(root, 'experiment.mjs'), run = join(root, 'run'), submission = join(root, 'submission.json');
  await command('init', '--out', config);
  const source = await readFile(config, 'utf8');
  assert.doesNotMatch(source, /dsh|apiKey\s*:\s*['"][^'"]+['"]/i);
  const checked = JSON.parse((await command('check', '--config', config, '--budget', '10', '--max-tokens', '1000')).stdout);
  assert.equal(checked.inferenceRun, false); assert.equal(checked.paid, false);
  assert.equal(checked.maxTokens, 1000); assert.equal(checked.tokenMinimumFits, true);
  await command('run', '--config', config, '--budget', '10', '--max-tokens', '1000', '--out', run);
  const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
  assert.equal(result.status, 'completed'); assert.equal(result.accounting.occupiedMicros, 0);
  assert.equal(result.accounting.maxTokens, 1000); assert.equal(result.accounting.occupiedTokens, 0);
  assert.equal(result.test.kind, 'paired'); assert.equal(result.test.candidateAccuracy, 1);
  const status = JSON.parse((await command('status', '--run', run)).stdout);
  assert.equal(status.phase, 'completed'); assert.equal(status.pending, false);
  // Inspection/export do not load application modules.
  await writeFile(config, 'throw new Error("Configuration must not be imported by status or export");\n');
  await command('status', '--run', run);
  await rejection(['export', '--run', run, '--out', submission, '--id', 'example', '--summary', 'Offline smoke'], /review/i);
  await command('export', '--run', run, '--out', submission, '--id', 'example', '--summary', 'Offline smoke', '--reviewed');
  const review = JSON.parse((await command('validate', '--file', submission)).stdout);
  assert.equal(review.synthetic, true); assert.equal(review.eligibleForPromotion, false);
  const bundle = await readFile(submission, 'utf8');
  assert.equal(bundle.includes(run.replaceAll('\\', '\\\\')), false);
  await rejection(['export', '--run', run, '--out', submission, '--id', 'example', '--summary', 'Offline smoke', '--reviewed'], /EEXIST|exist/i);
});

test('CLI requires an explicit budget, rejects unknown flags, and refuses scaffold overwrite', async t => {
  const root = await temp(t), config = join(root, 'fixture.mjs');
  await command('init', '--out', config);
  const before = await readFile(config, 'utf8');
  await rejection(['init', '--out', config], /EEXIST|exist/i);
  assert.equal(await readFile(config, 'utf8'), before);
  await rejection(['run', '--config', config, '--out', join(root, 'run')], /budget/i);
  await rejection(['run', '--config', config, '--out', join(root, 'run'), '--budget', '10', '--unknown'], /unknown/i);
  await writeFile(config, 'throw new Error("Invalid token ceilings must fail before import");\n');
  for (const count of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
    await rejection(['run', '--config', config, '--out', join(root, 'run'), '--budget', '10', '--max-tokens', count], /max-tokens must be a positive safe integer/);
  }
});

test('CLI paid opt-in is checked before invoking the application runner', async t => {
  const root = await temp(t), config = join(root, 'paid.mjs'), marker = join(root, 'called.txt');
  const entry = new URL('../src/index.js', import.meta.url).href;
  await writeFile(config, `
import { defineExperiment, defineAgent, createOfflineProposer, exactMatch } from ${JSON.stringify(entry)};
import { writeFile } from 'node:fs/promises';
export default defineExperiment({
  id: 'paid-fixture', description: 'No actual paid requests', objective: 'accuracy',
  agent: defineAgent({
    id: 'paid-agent', version: '1', components: { prompt: 'initial' },
    mutable: { prompt: { role: 'instructions', maxLength: 100 } },
    accounting: { kind: 'paid', maxCostUSD: 0.01, version: '1', enforcement: 'Test fixture',
      pricing: { source: 'fixture', checkedAt: '2026-11-03', inputUSDPerMillion: 1000, outputUSDPerMillion: 1000 },
      limits: { maxModelCalls: 1, maxInputTokens: 5, maxOutputTokens: 5, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 } },
    optimization: { proposer: createOfflineProposer([]), maxAttempts: 0 },
    async run() { await writeFile(${JSON.stringify(marker)}, 'unexpected'); throw new Error('Must not dispatch'); },
  }),
  dataset: { id: 'paid-data', version: '1', score: exactMatch,
    train: [{ id: 'train', input: 'a', expected: 'a' }],
    validation: [{ id: 'validation', input: 'b', expected: 'b' }],
    test: [{ id: 'test', input: 'c', expected: 'c' }],
  },
});
`);
  const check = JSON.parse((await command('check', '--config', config, '--budget', '10')).stdout);
  assert.equal(check.paid, true); assert.equal(check.inferenceRun, false);
  await rejection(['run', '--config', config, '--budget', '10', '--out', join(root, 'run')], /allow-paid/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('CLI explicit resume reuses completed work and cannot raise the original budget', async t => {
  const root = await temp(t), config = join(root, 'fixture.mjs'), run = join(root, 'run');
  await command('init', '--out', config);
  await command('run', '--config', config, '--budget', '10', '--out', run);
  const first = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
  await command('run', '--config', config, '--budget', '10', '--out', run, '--resume');
  const resumed = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
  assert.deepEqual(resumed.evaluations, first.evaluations);
  assert.deepEqual(resumed.accounting, first.accounting);
  await rejection(['run', '--config', config, '--budget', '11', '--out', run, '--resume'], /fingerprint/i);
  assert.equal(JSON.parse(await readFile(join(run, 'result.json'), 'utf8')).accounting.limitMicros, 10_000_000);
});

test('export refuses result tampering against the authoritative checkpoint', async t => {
  const root = await temp(t), config = join(root, 'fixture.mjs'), run = join(root, 'run');
  await command('init', '--out', config);
  await command('run', '--config', config, '--budget', '10', '--out', run);
  const resultPath = join(run, 'result.json'), checkpointPath = join(run, 'state.json');
  const original = JSON.parse(await readFile(resultPath, 'utf8')) as OptimizationResult<string>;
  const checkpoint = await readFile(checkpointPath, 'utf8');
  const mutations: [string, (result: OptimizationResult<string>) => void][] = [
    ['output', result => { result.evaluations[0]!.output = 'fabricated output'; }],
    ['pass', result => { result.evaluations[0]!.passed = !result.evaluations[0]!.passed; }],
    ['selected', result => { result.selectedId = result.candidates[0]!.id; }],
    ['cap', result => { result.accounting.limitMicros++; }],
    ['provenance', result => { result.provenance.datasetVersion = 'fabricated-version'; }],
  ];
  for (const [name, mutate] of mutations) {
    const modified = structuredClone(original); mutate(modified);
    await writeFile(resultPath, JSON.stringify(modified));
    const submission = join(root, `${name}.json`);
    await rejection(['export', '--run', run, '--out', submission, '--id', `tampered-${name}`, '--summary', 'Tampered evidence', '--reviewed'], /Result and checkpoint .* differ/);
    await assert.rejects(readFile(submission), { code: 'ENOENT' });
    assert.equal(await readFile(checkpointPath, 'utf8'), checkpoint);
  }
});

test('workflow lock excludes simultaneous runs until result persistence completes', { timeout: 20_000 }, async t => {
  const e = experiment(), directory = join(await temp(t), 'run');
  e.agent.accounting = { kind: 'free', timeoutMs: 10_000 };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const original = e.agent.run;
  e.agent.run = async args => { enter(); await released; return original(args); };
  const first = runExperiment(e, { budget: 10, directory });
  await entered;
  try {
    await assert.rejects(runExperiment(e, { budget: 10, directory }), /Experiment locked/);
  } finally { release(); }
  const result = await first;
  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')).status, 'completed');
  await assert.rejects(readFile(join(directory, 'experiment.lock')), { code: 'ENOENT' });
});

test('workflow completion never removes a replacement owner lock', { timeout: 20_000 }, async t => {
  const e = experiment(), directory = join(await temp(t), 'run');
  e.agent.accounting = { kind: 'free', timeoutMs: 10_000 };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const original = e.agent.run;
  e.agent.run = async args => { enter(); await released; return original(args); };
  const first = runExperiment(e, { budget: 10, directory });
  await entered;
  const lockPath = join(directory, 'experiment.lock');
  const replacement = { pid: process.pid, token: 'replacement-owner' };
  try { await writeFile(lockPath, JSON.stringify(replacement)); } finally { release(); }
  assert.equal((await first).status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacement);
});
