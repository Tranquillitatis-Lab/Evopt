import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent, createOfflineProposer, exactMatch } from '../src/index.js';
import { defineExperiment, runExperiment } from '../src/experiments.js';
import { validateSubmission } from '../src/contributions.js';
import { validateConfigurationPatch } from '../src/patch.js';
import { loadSWEExperiment } from '../src/swe-experiment.js';
import { prepareSWE } from '../benchmarks/import-swe.js';
import { createSWERepositoryFixture } from './fixtures/swe-repository.js';
import { createFakeSWEHarness } from './fixtures/swe-harness.js';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../../bin/swe.mjs', import.meta.url));
const entry = new URL('../src/index.js', import.meta.url).href;
async function command(...args: string[]) {
  return exec(process.execPath, [cli, ...args], { timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, EVOPT_SWE_CONFIG: 'THIS_ENVIRONMENT_VARIABLE_MUST_NOT_BE_USED' } });
}
async function rejection(args: string[], pattern: RegExp) {
  await assert.rejects(command(...args), error => { assert.match((error as Error & { stderr: string }).stderr, pattern); return true; });
}
async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'evopt-swe-cli-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('SWE init writes explicit configuration without loading an agent or reading hidden environment setup', async t => {
  const root = await directory(t), out = join(root, 'config.json'), agent = join(root, 'agent.mjs');
  await writeFile(agent, 'throw new Error("Agent must not load during init");\n');
  const initialized = JSON.parse((await command('init', '--out', out, '--agent', agent)).stdout);
  assert.equal(initialized.inferenceRun, false); assert.equal(initialized.agentModule, resolve(agent));
  const config = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(config.version, 1); assert.equal(config.agentModule, resolve(agent)); assert.match(config.manifest, /<prepared/);
  assert.equal(config.budget, undefined); assert.equal(config.provider, undefined); assert.equal(config.maxTokens, undefined);
  await rejection(['init', '--out', out, '--agent', agent], /EEXIST/);
  await rejection(['init', '--out', join(root, 'missing-agent.json')], /--agent required/);
  await rejection(['init', '--out', out, '--agent', agent, '--provider', 'openai'], /Unknown or duplicate/);
  await rejection(['init', '--out', out, '--out', out, '--agent', agent], /Unknown or duplicate/);
  await rejection(['check', '--config', out, '--budget', '1'], /placeholder/);
  assert.match((await command('--help')).stdout, /total USD ceiling/);
});

test('SWE check and run validate explicit monetary and token ceilings before loading configuration', async () => {
  for (const commandName of ['check', 'run']) {
    const base = [commandName, '--config', 'nonexistent-config.json', ...(commandName === 'run' ? ['--out', 'unused-run'] : [])];
    await rejection(base, /--budget required/);
    for (const value of ['0', '-1', 'Infinity', 'NaN', '0x10', '0.0000001']) await rejection([...base, '--budget', value], /--budget/);
    for (const value of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) await rejection([...base, '--budget', '1', '--max-tokens', value], /--max-tokens/);
  }
});

test('SWE loader rejects unknown settings, invalid pins and malformed manifests before agent import', async t => {
  const root = await directory(t), configPath = join(root, 'config.json'), agent = join(root, 'agent.mjs');
  await writeFile(agent, 'throw new Error("AGENT_IMPORT_MUST_NOT_RUN");\n');
  await writeFile(join(root, 'manifest.json'), '{}'); await writeFile(join(root, 'source.json'), '[]');
  const base = { version: 1, agentModule: './agent.mjs', manifest: './manifest.json', datasetFile: './source.json',
    harness: { python: process.execPath, cwd: root, revision: 'a'.repeat(40), evidenceDirectory: join(root, 'evidence') } };
  const invalid = [ { ...base, objective: 'code-generation' }, { ...base, version: 2 }, { ...base, agentModule: undefined },
    { ...base, harness: { ...base.harness, provider: 'implicit' } }, { ...base, harness: { ...base.harness, python: 'python' } },
    { ...base, harness: { ...base.harness, revision: 'main' } }, { ...base, harness: { ...base.harness, timeoutMs: 0 } }, base ];
  for (const value of invalid) {
    await writeFile(configPath, JSON.stringify(value));
    await assert.rejects(loadSWEExperiment(configPath), error => { assert.doesNotMatch(String(error), /AGENT_IMPORT_MUST_NOT_RUN/); return true; });
  }
});

test('SWE submission exports an exclusive reviewed bundle and reads status/review without importing any agent', async t => {
  const root = await directory(t), run = join(root, 'run'), out = join(root, 'bundle');
  const agent = defineAgent<string, string>({ id: 'offline-swe-cli-fixture', version: '1', components: { prompt: 'initial' },
    mutable: { prompt: { role: 'Normalize category', maxLength: 100 } }, accounting: { kind: 'free', timeoutMs: 1000 },
    optimization: { proposer: createOfflineProposer([{ prompt: 'lowercase' }]), maxAttempts: 1 },
    async run({ input, components }) { return { output: components.prompt === 'lowercase' ? input.toLowerCase() : input, usage: { complete: true, receipts: [] } }; } });
  await runExperiment(defineExperiment({ id: 'synthetic-fixture', description: 'Authored offline CLI fixture, not benchmark evidence.', objective: 'accuracy', agent,
    dataset: { id: 'synthetic', version: '1', score: exactMatch,
      train: [{ id: 'train', input: 'A', expected: 'a' }], validation: [{ id: 'validation', input: 'B', expected: 'b' }], test: [{ id: 'test', input: 'C', expected: 'c' }] } }),
  { budget: 1, directory: run });
  assert.equal(JSON.parse((await command('status', '--run', run)).stdout).phase, 'completed');
  const review = JSON.parse((await command('review', '--run', run)).stdout); assert.equal(review.paired.improved, 1);
  const args = ['submit', '--run', run, '--out', out, '--id', 'fixture', '--summary', 'Offline reviewed evidence fixture'];
  await rejection(args, /--reviewed/);
  await assert.rejects(readdir(out), /ENOENT/);
  const submitted = JSON.parse((await command(...args, '--reviewed')).stdout);
  assert.equal(submitted.published, false); assert.equal(submitted.synthetic, true); assert.equal(submitted.inferenceRun, false);
  assert.deepEqual((await readdir(out)).sort(), ['README.md', 'patch.json', 'submission.json']);
  const submission = JSON.parse(await readFile(join(out, 'submission.json'), 'utf8'));
  assert.equal(validateSubmission(submission).synthetic, true);
  const patch = JSON.parse(await readFile(join(out, 'patch.json'), 'utf8')); validateConfigurationPatch(patch); assert.equal(patch.edits.length, 1);
  const readme = await readFile(join(out, 'README.md'), 'utf8'); assert.match(readme, /synthetic/); assert.match(readme, /--budget 1/);
  await rejection([...args, '--reviewed'], /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'submission.json'), 'utf8')), submission);
});

test('SWE check and run use an explicitly configured agent with a fake local evaluator and preserve a token cap', async t => {
  let python: string;
  try { python = (await exec('python', ['-c', 'import sys; print(sys.executable)'])).stdout.trim(); }
  catch { t.skip('Python required for the local fake evaluator'); return; }
  const root = await directory(t), repository = await createSWERepositoryFixture(root), manifest = await prepareSWE(repository);
  const harness = await createFakeSWEHarness(join(root, 'evaluator-fixture'), python);
  const manifestFile = join(root, 'manifest.json'), configFile = join(root, 'config.json'), agentModule = join(root, 'agent.mjs'), callsFile = join(root, 'calls.jsonl');
  await writeFile(manifestFile, JSON.stringify(manifest));
  // Synthetic callbacks and usage only; the fake Python package never contacts Docker.
  await writeFile(agentModule, `import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { defineAgent } from ${JSON.stringify(entry)};
const accounting = { kind: 'paid', version: 'authored-fixture', maxCostUSD: 0.0002,
  limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'Authored synthetic test tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1 }, enforcement: 'Local deterministic fixture' };
const receipt = (context, inputTokens) => ({ complete: true, receipts: [{ id: context.evaluationId, provider: 'fixture', model: 'fixture', inputTokens, outputTokens: 10, cachedInputTokens: 0 }] });
export const agent = defineAgent({ id: 'synthetic-swe-cli-agent', version: '1', components: { prompt: 'baseline' },
  mutable: { prompt: { role: 'Issue repair guidance', maxLength: 100 } }, accounting,
  optimization: { maxAttempts: 1, proposer: { id: 'fixture-proposer', version: '1', accounting,
    async propose(request, context) { assert.equal(request.selection.metric, 'tokens'); await appendFile(${JSON.stringify(callsFile)}, 'proposal\\n');
      return { output: { prompt: 'short' }, usage: receipt(context, 1) }; } } },
  async run({ input, components, context }) { assert.equal(JSON.stringify(input).includes('hidden-'), false);
    await appendFile(${JSON.stringify(callsFile)}, 'target\\n'); return { output: 'pass', usage: receipt(context, components.prompt === 'short' ? 10 : 80) }; } });
`);
  await command('init', '--out', configFile, '--agent', agentModule, '--manifest', manifestFile, '--source', repository.sourceFile,
    '--python', python, '--harness', harness.cwd, '--revision', harness.revision, '--evidence', join(root, 'grading'));
  const check = JSON.parse((await command('check', '--config', configFile, '--budget', '1', '--max-tokens', '2000')).stdout);
  assert.equal(check.inferenceRun, false); assert.equal(check.evaluatorReady, true); assert.equal(check.objective, 'tokens'); assert.equal(check.paid, true);
  await assert.rejects(readFile(callsFile), /ENOENT/);
  const badModule = join(root, 'unmetered-agent.mjs'), badConfig = join(root, 'bad-config.json');
  await writeFile(badModule, `export const agent = { id: 'unmetered', version: '1', components: { prompt: 'x' },
    mutable: { prompt: { role: 'Instructions', maxLength: 10 } }, run() { throw new Error('UNAUTHORIZED_CALLBACK'); }, optimization: {} };\n`);
  await writeFile(badConfig, JSON.stringify({ ...JSON.parse(await readFile(configFile, 'utf8')), agentModule: badModule }));
  await rejection(['check', '--config', badConfig, '--budget', '1'], /Missing accounting contract/);
  await assert.rejects(readFile(callsFile), /ENOENT/);
  const run = join(root, 'run');
  await rejection(['run', '--config', configFile, '--budget', '1', '--max-tokens', '2000', '--out', run], /--allow-paid/);
  await assert.rejects(readFile(callsFile), /ENOENT/);
  const completed = JSON.parse((await command('run', '--config', configFile, '--budget', '1', '--max-tokens', '2000', '--out', run, '--allow-paid')).stdout);
  assert.equal(completed.status, 'completed'); assert.equal(completed.currency, 'USD'); assert.equal(completed.maxTokens, 2000);
  assert.ok(completed.occupiedTokens > 0 && completed.occupiedTokens <= 2000);
  const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
  assert.equal(result.components.prompt, 'short'); assert.equal(result.configuration.objective, 'tokens');
  assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 1, candidateAccuracy: 1 });
  assert.equal(result.provenance.benchmark.sourceSha256, repository.sourceSha256);
  const calls = await readFile(callsFile, 'utf8'); assert.equal(calls.trim().split('\n').filter(row => row === 'proposal').length, 1);
  await command('run', '--config', configFile, '--budget', '1', '--max-tokens', '2000', '--out', run, '--allow-paid', '--resume');
  assert.equal(await readFile(callsFile, 'utf8'), calls);
  const bundle = join(root, 'bundle');
  await command('submit', '--run', run, '--out', bundle, '--id', 'synthetic-swe-fixture', '--summary', 'Authored fake harness and provider receipts, not benchmark evidence.', '--reviewed');
  const guide = await readFile(join(bundle, 'README.md'), 'utf8'); assert.match(guide, /--max-tokens 2000/); assert.ok(guide.includes(repository.sourceSha256));
  await writeFile(repository.sourceFile, '[]');
  await writeFile(badModule, 'throw new Error("AGENT_IMPORTED_BEFORE_SOURCE_CHECK");\n');
  await rejection(['check', '--config', badConfig, '--budget', '1'], /SHA|digest|hash|changed|match/i);
  assert.equal(await readFile(callsFile, 'utf8'), calls);
});
