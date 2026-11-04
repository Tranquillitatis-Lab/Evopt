import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('offline command line run produces verifiable evidence without reopening search', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const work = await mkdtemp(path.join(tmpdir(), 'evopt-cli-'));
  try {
    const config = path.join(work, 'config.json'), result = path.join(work, 'result.json');
    await writeFile(config, JSON.stringify({ version: 1,
      agentModule: path.join(root, 'dist/examples/offline-agent.js'),
      datasetModule: path.join(root, 'dist/examples/offline-dataset.js'),
      lanes: [path.join(root, 'lanes/operations.json')], output: path.join(work, 'run'),
      budget: { maxUSD: 1, maxTokens: 100000 }, seed: 1,
      search: { population: 2, generations: 1, elites: 1, llmMutation: false },
      evaluation: { repetitions: 1, order: 'balanced' },
    }));
    const cli = path.join(root, 'dist/bin/evopt.js');
    const invoke = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(invoke('doctor', '--config', config)).valid, true);
    assert.equal(JSON.parse(invoke('preflight', '--config', config)).inferenceRun, false);
    invoke('run', '--config', config);
    invoke('validate', '--config', config);
    invoke('export', '--config', config, '--lane', 'operations', '--out', result);
    assert.equal(JSON.parse(invoke('verify', '--file', result)).valid, true);
    const submission = JSON.parse(await readFile(result, 'utf8'));
    submission.evidence.pairs[0].candidateTokens++;
    await writeFile(result, JSON.stringify(submission));
    assert.throws(() => invoke('verify', '--file', result));
    assert.throws(() => invoke('run', '--config', config));
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('benchmark command imports an explicitly partitioned local SWE export', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const work = await mkdtemp(path.join(tmpdir(), 'evopt-swe-import-'));
  try {
    const input = path.join(work, 'input.json'), settings = path.join(work, 'settings.json'), output = path.join(work, 'manifest.json');
    const ids = ['owner__train', 'owner__gate', 'owner__test'];
    await writeFile(input, JSON.stringify(ids.map(instance_id => ({ instance_id, problem_statement: 'Fix the bug', base_commit: 'a'.repeat(40), repo: 'owner/project' }))));
    await writeFile(settings, JSON.stringify({ dataset: 'princeton-nlp/SWE-bench', revision: 'b'.repeat(40), repositoryRoot: work,
      groups: { train: [ids[0]], gate: [ids[1]], test: [ids[2]] } }));
    const cli = path.join(root, 'dist/bin/evopt.js');
    const report = JSON.parse(execFileSync(process.execPath, [cli, 'benchmark', '--input', input, '--settings', settings, '--out', output], { encoding: 'utf8' }));
    assert.equal(report.tasks, 3);
    assert.equal(report.inferenceRun, false);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).tasks.length, 3);
  } finally { await rm(work, { recursive: true, force: true }); }
});
