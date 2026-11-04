import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, invokeTarget, normalizeUsage, propose, scoreTarget } from '../src/runner.ts';
import type { Lane } from '../src/types.ts';

const lane: Lane = { id: 'instructions', scope: 'Instructions', protectedPolicy: 'Keep the contract.',
  genes: { prompt: { type: 'text', initial: 'baseline', maxChars: 100 } } };
const free = { kind: 'free' as const, timeoutMs: 1000 };

test('target receives fresh input, components, and context while expected answers stay with scorer', async () => {
  const ids = new Set<string>();
  const task = { id: 'one', input: { question: 'hello' }, expected: 'secret expected' };
  const config = { agent: { id: 'agent', version: '1', components: { prompt: 'baseline', policy: 'immutable' },
    mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, accounting: free,
    async run(args: any) {
      assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
      assert.equal(args.components.policy, 'immutable'); assert.equal(args.components.prompt, 'short');
      assert.equal(JSON.stringify(args).includes('secret expected'), false);
      assert.ok(args.context.signal instanceof AbortSignal); assert.equal(ids.has(args.context.evaluationId), false); ids.add(args.context.evaluationId);
      args.input.question = 'mutated in agent';
      return { output: 'answer', usage: { complete: true, receipts: [] } };
    } }, dataset: { score: ({ input, output, expected }: any) => input.question === 'hello' && output === 'answer' && expected === 'secret expected' } };
  assert.equal((await evaluate(config, lane, { prompt: 'short' }, task, 'unused')).success, true);
  assert.equal((await evaluate(config, lane, { prompt: 'short' }, task, 'unused')).success, true);
  assert.equal(ids.size, 2); assert.equal(task.input.question, 'hello');
  await assert.rejects(evaluate(config, lane, { prompt: 'x'.repeat(101) }, task, 'unused'), /maxChars|limit/);
});

test('known billed usage can settle before scorer failure and the same output can be rescored', async () => {
  let calls = 0, fail = true;
  const paid = { kind: 'paid' as const, version: 'fixture', maxCostUSD: 1, enforcement: 'Fixture',
    pricing: { source: 'fixture', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1 },
    limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 } };
  const config = { agent: { components: { prompt: 'baseline' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, accounting: paid,
    async run({ context }: any) { calls++; return { output: 'answer', usage: { complete: true, receipts: [{ id: context.evaluationId, provider: 'fixture', model: 'fixture', inputTokens: 8, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: 1 }] } }; } },
    dataset: { score: () => { if (fail) { fail = false; throw new Error('scorer unavailable'); } return true; } } };
  const task = { id: 'one', input: 'question', expected: 'answer' };
  const invocation = await invokeTarget(config, lane, { prompt: 'short' }, task, 'unused');
  assert.equal(invocation.tokens, 10); assert.equal(invocation.usage.receipts[0]!.cachedInputTokens, 3);
  await assert.rejects(scoreTarget(config, task, invocation), /scorer unavailable/);
  assert.equal((await scoreTarget(config, task, invocation)).success, true); assert.equal(calls, 1);
});

test('proposer receives lane metadata and actual training feedback without fabricated answers', async () => {
  let request: any;
  const config = { agent: { components: { prompt: 'baseline', privatePolicy: 'not sent' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, accounting: free,
    async run() { throw new Error('unexpected target call'); }, optimization: { proposer: { accounting: free,
      async propose(value: any) { request = value; return { output: { prompt: 'short' }, usage: { complete: true, receipts: [] } }; } } } } };
  const context = { evaluationId: 'proposal-1', signal: new AbortController().signal, attempt: 4 };
  const result = await propose(config, lane, [{ prompt: 'baseline' }], { scope: 'train-only', observations: [{ tokens: 10 }] }, 'unused', context);
  assert.equal(result.text, '{"prompt":"short"}'); assert.equal(request.attempt, 4);
  assert.deepEqual(request.feedback, []); assert.equal(request.experience.scope, 'train-only');
  assert.equal(request.evolution.lane.protectedPolicy, 'Keep the contract.');
  assert.equal(JSON.stringify(request).includes('not sent'), false);
  assert.throws(() => normalizeUsage({ complete: true, receipts: [{ id: 'x', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 }] }, free), /subset/);
});

test('unserializable target and proposal outputs retain receipts for settlement', async () => {
  const circular: any = {}; circular.self = circular;
  const config = { agent: { components: { prompt: 'baseline' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, accounting: free,
    async run() { return { output: circular, usage: { complete: true, receipts: [] } }; },
    optimization: { proposer: { accounting: free, async propose() { return { output: circular, usage: { complete: true, receipts: [] } }; } } } },
    dataset: { score: () => { throw new Error('must not score malformed output'); } } };
  const task = { id: 'one', input: 'question', expected: 'answer' };
  const invocation = await invokeTarget(config, lane, { prompt: 'baseline' }, task, 'unused');
  assert.equal(invocation.outputInvalid, true); assert.equal(invocation.usage.complete, true);
  await assert.rejects(scoreTarget(config, task, invocation), /JSON-serializable/);
  const proposal = await propose(config, lane, [{ prompt: 'baseline' }], [], 'unused');
  assert.equal(proposal.text, ''); assert.equal(proposal.usage.complete, true);
  assert.throws(() => JSON.parse(proposal.text));
});
