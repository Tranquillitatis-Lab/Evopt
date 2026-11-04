import { randomUUID } from 'node:crypto';
import type { Accounting, Components, InvocationResult, Lane, RunContext, UsageReceipt } from './types.ts';
import { validateGenome } from './genome.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nonnegativeInteger(value: unknown, label: string): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `Invalid ${label}`);
}

/** Cached input and reasoning are subsets of input and output respectively. */
export function normalizeUsage(usage: unknown, accounting: Accounting): { tokens: number; usage: { complete: true; receipts: UsageReceipt[] } } {
  assert(usage !== null && typeof usage === 'object' && 'complete' in usage && usage.complete === true
    && 'receipts' in usage && Array.isArray(usage.receipts), 'Complete normalized usage receipts are required');
  assert(accounting?.kind === 'free' || accounting?.kind === 'paid', 'Missing invocation accounting');
  if (accounting.kind === 'paid') assert(usage.receipts.length > 0, 'Paid invocation requires receipts');
  const identities = new Set<string>();
  let tokens = 0;
  const receipts = usage.receipts.map((value: unknown) => {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Malformed usage receipt');
    const receipt = value as UsageReceipt;
    for (const key of ['id', 'provider', 'model'] as const) assert(typeof receipt[key] === 'string' && receipt[key].trim(), `Missing receipt ${key}`);
    const identity = JSON.stringify([receipt.provider, receipt.id]);
    assert(!identities.has(identity), 'Duplicate usage receipt'); identities.add(identity);
    nonnegativeInteger(receipt.inputTokens, 'input tokens');
    nonnegativeInteger(receipt.outputTokens, 'output tokens');
    nonnegativeInteger(receipt.cachedInputTokens, 'cached input tokens');
    assert(receipt.cachedInputTokens <= receipt.inputTokens, 'Cached input must be an input subset');
    if (receipt.reasoningTokens !== undefined) {
      nonnegativeInteger(receipt.reasoningTokens, 'reasoning tokens');
      assert(receipt.reasoningTokens <= receipt.outputTokens, 'Reasoning must be an output subset');
    }
    if (receipt.extraCostUSD !== undefined) assert(typeof receipt.extraCostUSD === 'number'
      && Number.isFinite(receipt.extraCostUSD) && receipt.extraCostUSD >= 0, 'Invalid paid-tool charge');
    if (accounting.kind === 'free') assert(receipt.inputTokens === 0 && receipt.outputTokens === 0
      && (receipt.extraCostUSD ?? 0) === 0, 'Free integration reported paid usage');
    tokens += receipt.inputTokens + receipt.outputTokens;
    nonnegativeInteger(tokens, 'total tokens');
    return structuredClone(receipt);
  });
  return { tokens, usage: { complete: true, receipts } };
}

function invocationContext(context: RunContext | undefined, accounting: Accounting): RunContext {
  if (context !== undefined) {
    assert(context.signal instanceof AbortSignal && typeof context.evaluationId === 'string' && context.evaluationId.length > 0, 'Invalid invocation context');
    context.signal.throwIfAborted();
    return context;
  }
  const timeout = accounting.kind === 'paid' ? accounting.limits.timeoutMs : accounting.timeoutMs;
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2147483647, 'Invalid invocation timeout');
  return { evaluationId: randomUUID(), signal: AbortSignal.timeout(timeout),
    ...(accounting.kind === 'paid' ? { limits: structuredClone(accounting.limits) } : {}) };
}

/** Map named lane genes to explicitly mutable agent text. */
function componentsFor(config: any, lane: Lane, genome: Record<string, string>, baseline: boolean): Components {
  const agent = config.agent;
  assert(agent?.components && agent?.mutable && typeof agent.run === 'function', 'A configured agent is required');
  validateGenome(lane, genome);
  const components = { ...agent.components };
  const bindings: Record<string, string> = agent.optimization?.bindings?.[lane.id] ?? {};
  for (const [gene, value] of Object.entries(genome)) {
    const key = bindings[gene] ?? gene;
    assert(Object.hasOwn(agent.mutable, key) && Object.hasOwn(components, key), `Lane gene ${gene} must bind to an allowed agent component`);
    assert(typeof value === 'string' && value.length <= agent.mutable[key].maxLength, `Lane gene ${gene} exceeds its component limit`);
    if (!baseline) components[key] = value;
  }
  return Object.freeze(components);
}

/** Agent state and tool fixtures are fresh for each application callback. */
export async function invokeTarget(config: any, lane: Lane, genome: Record<string, string>, task: any, _dir: string, suppliedContext?: RunContext) {
  const agent = config.agent;
  assert(typeof config.dataset?.score === 'function', 'A deterministic local dataset scorer is required');
  assert(task && Object.hasOwn(task, 'input') && Object.hasOwn(task, 'expected'), 'A labeled evaluation task is required');
  const components = componentsFor(config, lane, genome, task.baselineWithoutGuidance === true);
  const context = invocationContext(suppliedContext, agent.accounting);
  const result: InvocationResult<unknown> = await agent.run({ input: structuredClone(task.input), components, context });
  const normalized = normalizeUsage(result?.usage, agent.accounting);
  let output: unknown = null, outputInvalid = false, trace: unknown;
  try {
    const json = JSON.stringify(result.output);
    if (json === undefined) throw new Error('Unserializable output');
    output = JSON.parse(json);
  } catch { outputInvalid = true; }
  try { if (result.trace !== undefined) trace = JSON.parse(JSON.stringify(result.trace)); } catch { /* Usage remains settleable if optional trace is invalid. */ }
  return { task: task.id, ...normalized,
    output, ...(outputInvalid ? { outputInvalid: true } : {}), ...(trace === undefined ? {} : { trace }),
    invocationId: context.evaluationId, synthetic: agent.accounting.kind === 'free' };
}

/** Scoring runs after the caller has durably settled and stored target usage. */
export async function scoreTarget(config: any, task: any, invocation: Awaited<ReturnType<typeof invokeTarget>>) {
  assert(!invocation.outputInvalid, 'Agent output must be JSON-serializable');
  const success = await config.dataset.score({ input: structuredClone(task.input), output: structuredClone(invocation.output), expected: structuredClone(task.expected) });
  assert(typeof success === 'boolean', 'Dataset scorer must return a boolean');
  return { ...invocation, success, safety: true, selectionEligible: true };
}

export async function evaluate(config: any, lane: Lane, genome: Record<string, string>, task: any, dir: string, suppliedContext?: RunContext) {
  return scoreTarget(config, task, await invokeTarget(config, lane, genome, task, dir, suppliedContext));
}

/** Proposals receive lane text and training feedback, never validation/test labels. */
export async function propose(config: any, lane: Lane, parents: Record<string, string>[], feedback: unknown, _dir: string, suppliedContext?: RunContext) {
  const agent = config.agent, proposer = agent?.optimization?.proposer;
  assert(proposer && typeof proposer.propose === 'function', 'A configured candidate proposer is required');
  assert(Array.isArray(parents) && parents.length > 0, 'A proposal requires parent text');
  componentsFor(config, lane, parents[0]!, false);
  const bindings: Record<string, string> = agent.optimization?.bindings?.[lane.id] ?? {};
  const mutable = Object.fromEntries(Object.keys(lane.genes).map(gene => [gene, structuredClone(agent.mutable[bindings[gene] ?? gene])]));
  const context = invocationContext(suppliedContext, proposer.accounting);
  const details = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback as { examples?: unknown; experience?: unknown } : undefined;
  const examples = Array.isArray(feedback) ? feedback : Array.isArray(details?.examples) ? details.examples : [];
  const experience = details?.experience ?? (Array.isArray(feedback) ? undefined : feedback);
  const result: InvocationResult<Record<string, string>> = await proposer.propose({ components: Object.freeze(structuredClone(parents[0]!)),
    mutable: Object.freeze(mutable), feedback: structuredClone(examples),
    ...(experience === undefined ? {} : { experience: structuredClone(experience) }),
    attempt: (suppliedContext as (RunContext & { attempt?: number }) | undefined)?.attempt ?? 1,
    ...(agent.structure ? { structure: structuredClone(agent.structure) } : {}),
    evolution: { lane: structuredClone(lane), parents: structuredClone(parents) } }, context);
  const normalized = normalizeUsage(result?.usage, proposer.accounting);
  let output: string | undefined;
  try { output = JSON.stringify(result.output); } catch { /* Preserve usage for settlement. */ }
  output ??= '';
  return { text: output, ...normalized, invocationId: context.evaluationId };
}
