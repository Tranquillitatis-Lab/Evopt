import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildConfig } from '../src/config.ts';
import { exportWinner, runSearch, validateFinal } from '../src/search.ts';
import type { Accounting, Agent, Dataset, Lane } from '../src/types.ts';

const accounting: Accounting = {
  kind: 'paid', version: 'fixture', maxCostUSD: 0.001, enforcement: 'Local deterministic fixture',
  limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 5000 },
  pricing: { source: 'fixture', checkedAt: '2025-01-01', inputUSDPerMillion: 1, outputUSDPerMillion: 1 },
};
const lanes: Lane[] = ['first', 'second'].map(id => ({
  id, scope: 'Prompt', protectedPolicy: '', genes: { prompt: { type: 'text', initial: 'verbose', maxChars: 30 } },
}));
const dataset: Dataset<string, string> = {
  id: 'fixture', version: '1',
  train: [{ id: 'train', input: 'train input', expected: 'answer' }],
  validation: [{ id: 'validation', input: 'validation input', expected: 'answer' }],
  test: [{ id: 'test', input: 'test input', expected: 'answer' }],
  score: ({ output, expected }) => output === expected,
};

function fixture(run: Agent<string, string>['run']): Agent<string, string> {
  return {
    id: 'agent', version: '1', components: { prompt: 'verbose' },
    mutable: { prompt: { role: 'system prompt', maxLength: 30 } }, accounting, run,
    optimization: { maxAttempts: 1, proposer: {
      id: 'offline', version: '1', accounting: { kind: 'free', timeoutMs: 1000 },
      async propose() { return { output: { prompt: 'short' }, usage: { complete: true, receipts: [] } }; },
    } },
  };
}

function result(prompt: string) {
  return { output: 'answer', usage: { complete: true as const, receipts: [{
    id: randomUUID(), provider: 'fixture', model: 'fixture', inputTokens: prompt === 'short' ? 2 : 10,
    outputTokens: 1, cachedInputTokens: 0,
  }] } };
}

test('lanes evaluate identical text independently, share a ceiling and seal the repeated holdout', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-engine-'));
  const calls: string[] = [];
  try {
    const agent = fixture(async ({ input, components }) => { calls.push(`${input}:${components.prompt}`); return result(components.prompt); });
    const config = buildConfig({ agent, dataset, lanes, output: directory, budget: 0.1,
      search: { population: 2, generations: 1, elites: 2, llmMutation: true }, evaluation: { repetitions: 2 } });
    const first = await runSearch(config, lanes[0]);
    const second = await runSearch(config, lanes[1]);
    assert.notEqual(first.winner, second.winner);
    assert.equal(calls.filter(call => call === 'train input:short').length, 4);
    assert.equal(calls.filter(call => call.startsWith('test input:')).length, 0);
    const final = await validateFinal(config, lanes[0]);
    assert.equal(final.protocol.schedule.length, 2);
    assert.equal(final.statistics.tasks, 1);
    assert.equal(final.statistics.pairedObservations, 2);
    await assert.rejects(runSearch(config, lanes[1]), /holdout/i);
    await validateFinal(config, lanes[1]);
    await assert.rejects(exportWinner(config, lanes[0], path.join(directory, 'budget.json')), /outside/i);
    const ledger = JSON.parse(await readFile(path.join(directory, 'budget.json'), 'utf8')).budget;
    assert.equal(ledger.limitMicros, 100000);
    assert.ok(ledger.occupiedMicros <= ledger.limitMicros);
    assert.equal(ledger.entries.filter((entry: { episode: boolean }) => entry.episode).length, calls.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('insufficient shared reserve fails before dispatch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-budget-'));
  let calls = 0;
  try {
    const agent = fixture(async ({ components }) => { calls++; return result(components.prompt); });
    const config = buildConfig({ agent, dataset, lanes, output: directory, budget: 0.001 });
    await assert.rejects(runSearch(config, lanes[0]), /budget/i);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('later generations retain both possible final-arm allowances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-final-reserve-'));
  let proposals = 0;
  try {
    const agent = fixture(async ({ components }) => ({ output: 'answer', usage: { complete: true, receipts: [{
      id: randomUUID(), provider: 'fixture', model: 'fixture', inputTokens: components.prompt === 'short' ? 90 : 100,
      outputTokens: 0, cachedInputTokens: 0,
    }] } }));
    agent.accounting = { ...accounting, limits: { ...accounting.limits, maxOutputTokens: 0 },
      pricing: { source: 'fixture', checkedAt: '2025-01-01', inputUSDPerMillion: 10, outputUSDPerMillion: 10 } };
    agent.optimization.maxAttempts = 2;
    agent.optimization.proposer.propose = async () => ({ output: { prompt: ++proposals === 1 ? 'verbose' : 'short' },
      usage: { complete: true, receipts: [] } });
    const config = buildConfig({ agent, dataset, lanes: [lanes[0]], output: directory, budget: 0.005,
      search: { population: 2, generations: 2, elites: 1, llmMutation: true } });
    await runSearch(config, lanes[0]);
    const final = await validateFinal(config, lanes[0]);
    assert.equal(final.comparisonKind, 'identity-control');
    const ledger = JSON.parse(await readFile(path.join(directory, 'budget.json'), 'utf8')).budget;
    assert.ok(ledger.occupiedMicros <= ledger.limitMicros);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scoring failure resumes from settled output without repeating the paid call', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-recover-'));
  let calls = 0, fail = true;
  try {
    const agent = fixture(async ({ components }) => { calls++; return result(components.prompt); });
    const localDataset = { ...dataset, score: ({ output, expected }: { output: string; expected: string }) => {
      if (fail) { fail = false; throw new Error('scorer failed'); }
      return output === expected;
    } };
    const config = buildConfig({ agent, dataset: localDataset, lanes: [lanes[0]], output: directory, budget: 1,
      search: { population: 1, generations: 1, elites: 1, llmMutation: false } });
    await assert.rejects(runSearch(config, lanes[0]), /scorer failed/);
    assert.equal(calls, 1);
    await runSearch(config, lanes[0]);
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown invocation outcome retains its reservation and blocks resumption', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-unknown-'));
  let calls = 0;
  try {
    const agent = fixture(async () => { calls++; throw new Error('connection lost'); });
    const config = buildConfig({ agent, dataset, lanes: [lanes[0]], output: directory, budget: 1 });
    await assert.rejects(runSearch(config, lanes[0]), /connection lost/);
    await assert.rejects(runSearch(config, lanes[0]), /reservation retained/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
