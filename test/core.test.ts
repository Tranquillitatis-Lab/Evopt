import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optimize, defineAgent, createOfflineProposer, exactMatch } from 'evopt';
import type { Agent, Dataset, Accounting, InvocationResult, OptimizeOptions, RunContext } from 'evopt';

type Input = { value: string; nested: { visits: number } };
const data = (): Dataset<Input, string> => ({
  id: 'labels', version: '1', score: exactMatch,
  train: [{ id: 'train', input: { value: 'train-input', nested: { visits: 0 } }, expected: 'train-answer' }],
  validation: [{ id: 'validation', input: { value: 'validation-input', nested: { visits: 0 } }, expected: 'validation-answer' }],
  test: [
    { id: 'test-1', input: { value: 'test-1-input', nested: { visits: 0 } }, expected: 'test-1-answer' },
    { id: 'test-2', input: { value: 'test-2-input', nested: { visits: 0 } }, expected: 'test-2-answer' },
  ],
});
const free: Accounting = { kind: 'free', timeoutMs: 1000 };
const paid: Accounting = { kind: 'paid', maxCostUSD: 0.01, version: '1', enforcement: 'Mock transport enforces aggregate caps',
  limits: { maxModelCalls: 1, maxInputTokens: 5, maxOutputTokens: 5, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'test tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1000, outputUSDPerMillion: 1000 },
};
function reply(output: string, context?: RunContext): InvocationResult<string> {
  return { output, usage: { complete: true, receipts: context ? [{ id: context.evaluationId, provider: 'mock', model: 'mock', inputTokens: 2, outputTokens: 2, cachedInputTokens: 0 }] : [] } };
}
function agent(patches: readonly Record<string, string>[] = [{ prompt: 'better' }]): Agent<Input, string> {
  return defineAgent<Input, string>({ id: 'generic', version: '1', components: { prompt: 'initial', fixed: 'immutable' },
    mutable: { prompt: { role: 'system instruction', maxLength: 30 } }, accounting: free,
    optimization: { proposer: createOfflineProposer<Input, string>(patches), maxAttempts: patches.length },
    async run({ input, components }) { return reply(components.prompt === 'better' ? input.value.replace('-input', '-answer') : 'wrong'); },
  });
}
async function directory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'evopt-core-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('package API optimizes typed output using only training feedback and fresh evaluations', async t => {
  const a = agent(), d = data(), dir = await directory(t);
  const ids = new Set<string>(), calls: string[] = [];
  const run = a.run;
  a.run = async args => {
    assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
    assert.deepEqual(Object.keys(args.context).sort(), ['evaluationId', 'signal']);
    assert.equal(ids.has(args.context.evaluationId), false); ids.add(args.context.evaluationId);
    assert.ok(args.context.signal instanceof AbortSignal);
    assert.ok(Object.isFrozen(args.components)); assert.equal(args.components.fixed, 'immutable');
    assert.equal(args.input.nested.visits, 0); args.input.nested.visits++;
    calls.push(`${args.input.value}:${args.components.prompt}`);
    return { ...await run(args), trace: [{ type: 'private', data: 'trace-secret' }] };
  };
  const propose = a.optimization.proposer.propose;
  a.optimization.proposer.propose = async (request, context) => {
    assert.deepEqual(Object.keys(request.components), ['prompt']);
    assert.deepEqual(request.feedback.map(f => f.caseId), ['train']);
    assert.equal(JSON.stringify(request).includes('validation-answer'), false);
    assert.equal(JSON.stringify(request).includes('test-1-answer'), false);
    return propose(request, context);
  };
  const result = await optimize({ agent: a, dataset: d, objective: 'accuracy', budget: 10, run: { directory: dir } });
  assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'better');
  assert.deepEqual(result.changes, { prompt: { before: 'initial', after: 'better' } });
  assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 0, candidateAccuracy: 1 });
  assert.deepEqual(calls.slice(-4), ['test-1-input:initial', 'test-1-input:better', 'test-2-input:better', 'test-2-input:initial']);
  assert.equal(result.evaluations.length, 8);
  assert.equal(d.train[0]!.input.nested.visits, 0);
  assert.equal((await readFile(join(dir, 'state.json'), 'utf8')).includes('trace-secret'), false);
  const output: string = result.evaluations[0]!.output; assert.equal(typeof output, 'string');
});

test('runtime preflight rejects malformed configurations without invocation', async () => {
  let calls = 0;
  const a = agent(); a.run = async () => { calls++; return reply(''); };
  const base = { agent: a, dataset: data(), objective: 'accuracy', budget: 10 } as OptimizeOptions<Input, string>;
  const bad = [
    { ...base, budget: 0 }, { ...base, budget: NaN }, { ...base, budget: Infinity }, { ...base, budget: 0.0000001 },
    { ...base, objective: 'latency' },
    { ...base, dataset: { ...data(), train: [] } },
    { ...base, dataset: { ...data(), train: [{ id: 'train', input: {} }] } },
    { ...base, dataset: { ...data(), validation: [{ ...data().validation[0]!, id: 'train' }] } },
    { ...base, agent: { ...a, mutable: { absent: { role: 'prompt', maxLength: 10 } } } },
    { ...base, agent: { ...a, accounting: { kind: 'paid' } } },
  ];
  for (const item of bad) await assert.rejects(optimize(item as OptimizeOptions<Input, string>));
  assert.equal(calls, 0);
});

test('immutable edits, length violations, and duplicate proposals are rejected deterministically', async t => {
  const a = agent([{ fixed: 'override' }, { prompt: 'x'.repeat(31) }, { prompt: 'initial' }, { prompt: 'better' }, { prompt: 'better' }]);
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 10, run: { directory: await directory(t) } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.history.map(h => h.status), ['rejected', 'rejected', 'rejected', 'evaluated', 'rejected']);
  assert.match(result.history[0]!.reason!, /immutable/);
  assert.match(result.history[1]!.reason!, /oversized/);
  assert.match(result.history[2]!.reason!, /Duplicate/);
  assert.equal(result.candidates.length, 2);
});

test('validation ties retain baseline and label holdout as identity control', async t => {
  const a = agent([{ prompt: 'equally-wrong' }]);
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 10, run: { directory: await directory(t) } });
  assert.equal(result.components.prompt, 'initial');
  assert.equal(result.test!.kind, 'identity-control');
  assert.equal(result.evaluations.filter(e => e.split === 'test').length, 2);
});

test('test scores cannot change the frozen selection', async t => {
  const a = agent();
  a.run = async ({ input, components }) => reply(input.value.startsWith('test')
    ? components.prompt === 'initial' ? input.value.replace('-input', '-answer') : 'wrong'
    : components.prompt === 'better' ? input.value.replace('-input', '-answer') : 'wrong');
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 10, run: { directory: await directory(t) } });
  assert.equal(result.components.prompt, 'better');
  assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 1, candidateAccuracy: 0 });
});

test('paid baseline and holdout preflight and protected final budget', async t => {
  const a = agent(); let calls = 0;
  a.accounting = paid;
  a.run = async ({ context }) => { calls++; return reply('wrong', context); };
  await assert.rejects(optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 0.059999 }), /baseline and final/);
  assert.equal(calls, 0);
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 0.06, run: { directory: await directory(t) } });
  assert.equal(result.status, 'completed'); assert.equal(result.history.length, 0);
  assert.equal(result.accounting.limitMicros, 60000); assert.equal(result.accounting.occupiedMicros, 16000);
  assert.equal(result.accounting.entries.length, 4);
  assert.ok(result.accounting.entries.every(e => e.status === 'settled' && e.reservedMicros === 10000 && e.chargedMicros === 4000));
});

test('paid rejected proposals are still charged', async t => {
  const a = agent(); a.optimization.proposer.accounting = paid;
  a.optimization.proposer.propose = async (_request, context) => ({ ...reply('', context), output: { fixed: 'invalid' } });
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(result.history[0]!.status, 'rejected');
  assert.equal(result.accounting.occupiedMicros, 4000);
});

test('missing paid receipts retain reservation and refuse automatic resume', async t => {
  const a = agent(); a.accounting = paid; let calls = 0;
  a.run = async () => { calls++; return reply('wrong'); };
  const dir = await directory(t), options = { agent: a, dataset: data(), objective: 'accuracy' as const, budget: 1 };
  const result = await optimize({ ...options, run: { directory: dir } });
  assert.equal(result.status, 'interrupted'); assert.match(result.reason!, /receipts/);
  assert.equal(result.accounting.occupiedMicros, 10000); assert.equal(result.accounting.entries[0]!.status, 'pending');
  await assert.rejects(optimize({ ...options, run: { directory: dir, resume: true } }), /Unresolved billing/);
  assert.equal(calls, 1);
});

test('reported token envelope violation preserves measured charge and stops', async t => {
  const a = agent(); a.accounting = paid;
  a.run = async ({ context }) => { const r = reply('wrong', context); r.usage.receipts[0]!.inputTokens = 6; return r; };
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(result.status, 'interrupted'); assert.match(result.reason!, /exceeded/);
  assert.equal(result.accounting.entries[0]!.status, 'envelope_violation');
  assert.equal(result.accounting.entries[0]!.chargedMicros, 8000);
});

test('cancellation interrupts and resumed free run completes', async t => {
  const controller = new AbortController(); controller.abort();
  const dir = await directory(t), options = { agent: agent(), dataset: data(), objective: 'accuracy' as const, budget: 1 };
  const result = await optimize({ ...options, run: { directory: dir, signal: controller.signal } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'Cancelled');
  assert.equal(result.accounting.entries.length, 0);
  const resumed = await optimize({ ...options, run: { directory: dir, resume: true } });
  assert.equal(resumed.status, 'completed');
});

test('scorer failure preserves paid invocation and resume reuses output', async t => {
  const a = agent([]); a.accounting = paid; let calls = 0, failing = true;
  a.run = async ({ context }) => { calls++; return reply('wrong', context); };
  const d = data(); d.score = args => { if (failing) throw new Error('grader unavailable'); return exactMatch(args); };
  const dir = await directory(t), options = { agent: a, dataset: d, objective: 'accuracy' as const, budget: 1 };
  const first = await optimize({ ...options, run: { directory: dir } });
  assert.equal(first.status, 'interrupted'); assert.match(first.reason!, /Scorer failed/);
  assert.equal(calls, 1); assert.equal(first.accounting.occupiedMicros, 4000);
  failing = false;
  const resumed = await optimize({ ...options, run: { directory: dir, resume: true } });
  assert.equal(resumed.status, 'completed'); assert.equal(calls, 4);
  const again = await optimize({ ...options, run: { directory: dir, resume: true } });
  assert.equal(again.status, 'completed'); assert.equal(calls, 4);
  assert.deepEqual(again.evaluations, resumed.evaluations);
  await assert.rejects(optimize({ ...options, dataset: { ...d, version: '2' }, run: { directory: dir, resume: true } }), /fingerprint mismatch/);
});

test('non-JSON output retains known charge and cannot cause paid reinference on resume', async t => {
  const a = agent([]); a.accounting = paid; let calls = 0;
  a.run = async ({ context }) => { calls++; return { ...reply('', context), output: undefined as unknown as string }; };
  const dir = await directory(t), options = { agent: a, dataset: data(), objective: 'accuracy' as const, budget: 1 };
  const result = await optimize({ ...options, run: { directory: dir } });
  assert.equal(result.status, 'interrupted'); assert.match(result.reason!, /JSON/);
  assert.equal(result.accounting.entries[0]!.status, 'settled');
  assert.equal(result.accounting.occupiedMicros, 4000);
  await assert.rejects(optimize({ ...options, run: { directory: dir, resume: true } }), /output could not be saved/);
  assert.equal(calls, 1);
});

test('abort during async scoring stops promptly and resume reuses paid invocation', async t => {
  const a = agent([]); a.accounting = paid; let calls = 0;
  a.run = async ({ context }) => { calls++; return reply('wrong', context); };
  const controller = new AbortController(); let cancelScorer = true;
  const d = data();
  d.score = async args => {
    if (cancelScorer) { controller.abort(); return new Promise<boolean>(() => {}); }
    return exactMatch(args);
  };
  const dir = await directory(t), options = { agent: a, dataset: d, objective: 'accuracy' as const, budget: 1 };
  const first = await optimize({ ...options, run: { directory: dir, signal: controller.signal } });
  assert.equal(first.status, 'interrupted'); assert.match(first.reason!, /Cancelled/);
  assert.equal(calls, 1); assert.equal(first.accounting.entries[0]!.status, 'settled');
  cancelScorer = false;
  const resumed = await optimize({ ...options, run: { directory: dir, resume: true } });
  assert.equal(resumed.status, 'completed'); assert.equal(calls, 4);
});

test('abort during a paid invocation keeps its reservation and propagates the signal', async t => {
  const a = agent([]); a.accounting = paid;
  const controller = new AbortController(); let aborted = false;
  a.run = async ({ context }) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => { aborted = true; reject(context.signal.reason); }, { once: true });
    controller.abort();
  });
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 1,
    run: { directory: await directory(t), signal: controller.signal } });
  assert.equal(result.status, 'interrupted'); assert.equal(aborted, true);
  assert.equal(result.accounting.entries[0]!.status, 'pending');
  assert.equal(result.accounting.occupiedMicros, 10000);
});

test('resume in the middle of holdout preserves the frozen winner, proposal count, and paired order', async t => {
  const a = agent(); const calls: string[] = []; let proposals = 0, failTest = true;
  const run = a.run, propose = a.optimization.proposer.propose;
  a.run = async args => { calls.push(`${args.input.value}:${args.components.prompt}`); return run(args); };
  a.optimization.proposer.propose = async (request, context) => { proposals++; return propose(request, context); };
  const d = data(); d.score = args => {
    if (failTest && args.input.value === 'test-1-input' && args.output === 'test-1-answer') throw new Error('holdout grader interrupted');
    return exactMatch(args);
  };
  const dir = await directory(t), options = { agent: a, dataset: d, objective: 'accuracy' as const, budget: 1 };
  const interrupted = await optimize({ ...options, run: { directory: dir } });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.components.prompt, 'better');
  assert.equal(proposals, 1); assert.equal(calls.length, 6);
  const before = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).state;
  assert.equal(before.phase, 'test');
  failTest = false;
  const completed = await optimize({ ...options, run: { directory: dir, resume: true } });
  const after = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).state;
  assert.equal(completed.status, 'completed'); assert.equal(completed.selectedId, interrupted.selectedId);
  assert.equal(proposals, 1); assert.equal(calls.length, 8);
  assert.deepEqual(after.schedule, before.schedule);
  assert.deepEqual(calls.slice(-4), ['test-1-input:initial', 'test-1-input:better', 'test-2-input:better', 'test-2-input:initial']);
  assert.deepEqual(completed.test, { kind: 'paired', baselineAccuracy: 0, candidateAccuracy: 1 });
});

test('a supposedly free adapter reporting paid usage records a violation and cannot resume', async t => {
  const a = agent([]); let calls = 0;
  a.run = async ({ context }) => {
    calls++; const result = reply('wrong', context); result.usage.receipts[0]!.extraCostUSD = 0.003; return result;
  };
  const dir = await directory(t), options = { agent: a, dataset: data(), objective: 'accuracy' as const, budget: 1 };
  const result = await optimize({ ...options, run: { directory: dir } });
  assert.equal(result.status, 'interrupted');
  const entry = result.accounting.entries[0]!;
  assert.equal(entry.status, 'envelope_violation'); assert.equal(entry.receipts![0]!.extraCostUSD, 0.003);
  assert.equal(entry.receipts![0]!.inputTokens, 2); assert.equal(entry.chargedMicros, 3000);
  await assert.rejects(optimize({ ...options, run: { directory: dir, resume: true } }), /envelope violation/);
  assert.equal(calls, 1);
});

test('fractional token charges round upward after aggregating the invocation receipts', async t => {
  const a = agent([]);
  a.accounting = { ...paid, kind: 'paid', maxCostUSD: 0.000001,
    limits: { maxModelCalls: 2, maxInputTokens: 2, maxOutputTokens: 0, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
    pricing: { source: 'fractional test tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 0.1, outputUSDPerMillion: 0 },
  };
  a.run = async ({ context }) => ({ output: 'wrong', usage: { complete: true, receipts: [1, 2].map(n => ({
    id: `${context.evaluationId}:${n}`, provider: 'mock', model: 'mock', inputTokens: 1, outputTokens: 0, cachedInputTokens: 0,
  })) } });
  const result = await optimize({ agent: a, dataset: data(), objective: 'accuracy', budget: 0.000006,
    run: { directory: await directory(t) } });
  assert.equal(result.status, 'completed'); assert.equal(result.accounting.occupiedMicros, 4);
  assert.ok(result.accounting.entries.every(entry => entry.reservedMicros === 1 && entry.chargedMicros === 1 && entry.status === 'settled'));
});
