import { defineAgent } from '../index.ts';
import { validateAccounting } from '../budget.ts';
import type { Accounting, Agent, InvocationResult, ProposalRequest, Proposer, RunContext, UsageReceipt } from '../types.ts';

type PaidAccounting = Extract<Accounting, { kind: 'paid' }>;

/** Application-supplied hard limits. Evopt cannot verify or enforce Cursor's spending controls. */
export interface CursorBoundary {
  scope: 'per-invocation';
  maxCostUSD: number;
  singleModel: true;
  description: string;
}

/** Cursor SDK Agent.getUsage({ runId }) token and cost fields. */
export interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorCost { rawCostCents: number; chargedCents: number }
export interface CursorScopedUsage {
  usage: CursorUsage;
  cost?: CursorCost;
  runs: readonly { runId: string; usage: CursorUsage; cost?: CursorCost }[];
}

/** The callback obtains a settled, run-scoped SDK billing record. */
export interface CursorExecutionResult<O> {
  output: O;
  complete: boolean;
  settled: boolean;
  paidToolsUsed: boolean;
  agentId: string;
  runId: string;
  model: string;
  singleModel: boolean;
  modelCalls: number;
  usage: CursorScopedUsage;
  trace?: InvocationResult<O>['trace'];
}

export interface CursorSettings {
  model: string;
  /** Use conservative rates including Cursor fees and every applicable modifier. */
  accounting: PaidAccounting;
  /** Conservative upper bound for cache writes, including all applicable rate modifiers. */
  cacheWriteUSDPerMillion: number;
  boundary: CursorBoundary;
}

export interface CursorAgentOptions<I, O> extends Omit<Agent<I, O>, 'accounting' | 'run'>, CursorSettings {
  /** Create fresh state, enforce the independent boundary, and return settled usage. */
  run(args: { input: I; components: Agent<I, O>['components']; context: RunContext }): Promise<CursorExecutionResult<O>>;
}

export interface CursorProposerOptions<I, O> extends CursorSettings {
  id: string;
  version: string;
  /** Execute the proposer within the same independently enforced boundary. */
  propose(request: ProposalRequest<I, O>, context: RunContext): Promise<CursorExecutionResult<Record<string, string>>>;
}

function count(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Cursor ${label}`);
}

function dollars(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Cursor ${label}`);
}

function prepare(settings: CursorSettings): CursorSettings {
  if (!settings || typeof settings.model !== 'string' || !settings.model.trim()) throw new Error('A pinned Cursor model is required');
  if (!settings.accounting || settings.accounting.kind !== 'paid') throw new Error('Cursor requires explicit paid accounting');
  const accounting = structuredClone(settings.accounting);
  const boundary = structuredClone(settings.boundary);
  if (!boundary || boundary.scope !== 'per-invocation' || boundary.singleModel !== true || typeof boundary.description !== 'string' || !boundary.description.trim()) {
    throw new Error('Cursor requires an independently enforced, single-model per-invocation boundary');
  }
  dollars(boundary.maxCostUSD, 'boundary');
  if (boundary.maxCostUSD <= 0 || Math.ceil(boundary.maxCostUSD * 1e6) + 1 > Math.ceil(accounting.maxCostUSD * 1e6)) {
    throw new Error('Cursor accounting envelope requires one microdollar of rounding headroom above the independent boundary');
  }
  dollars(settings.cacheWriteUSDPerMillion, 'cache-write rate');
  validateAccounting(accounting);
  const limits = accounting.limits;
  if (limits.maxModelCalls < 1 || limits.maxPaidToolCalls !== 0) throw new Error('Cursor requires model calls and no paid tools');
  const pricing = accounting.pricing;
  const maximumInputRate = Math.max(pricing.inputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? Math.max(pricing.inputUSDPerMillion, pricing.outputUSDPerMillion), settings.cacheWriteUSDPerMillion);
  // Cover separate surcharge rounding and its USD-to-microdollar conversion.
  const maxMicros = Math.ceil(limits.maxInputTokens * maximumInputRate + limits.maxOutputTokens * pricing.outputUSDPerMillion) + 2;
  if (!Number.isSafeInteger(maxMicros) || Math.ceil(accounting.maxCostUSD * 1e6) < maxMicros) throw new Error('Cursor accounting envelope does not cover its cache-write rate');
  accounting.version = JSON.stringify([accounting.version, 'cursor-sdk-v1', settings.model, settings.cacheWriteUSDPerMillion, boundary]);
  return { model: settings.model, accounting, cacheWriteUSDPerMillion: settings.cacheWriteUSDPerMillion, boundary };
}

function checkUsage(value: CursorUsage): CursorUsage {
  if (!value || typeof value !== 'object') throw new Error('Cursor billed token usage is required');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const) count(value[key], key);
  const total = value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens;
  if (!Number.isSafeInteger(total) || value.totalTokens !== total || total === 0) throw new Error('Cursor billed token totals are inconsistent or unavailable');
  if (value.reasoningTokens !== undefined) {
    count(value.reasoningTokens, 'reasoningTokens');
    if (value.reasoningTokens > value.outputTokens) throw new Error('Cursor reasoning exceeds output tokens');
  }
  return value;
}

function checkCost(value: CursorCost | undefined): CursorCost {
  if (!value || typeof value !== 'object') throw new Error('Cursor settled billing is required');
  dollars(value.rawCostCents, 'rawCostCents'); dollars(value.chargedCents, 'chargedCents');
  return value;
}

function sameUsage(a: CursorUsage, b: CursorUsage): boolean {
  return a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens && a.totalTokens === b.totalTokens && a.reasoningTokens === b.reasoningTokens;
}

function checkedContext(context: RunContext, settings: CursorSettings): RunContext {
  if (!context || !(context.signal instanceof AbortSignal) || typeof context.evaluationId !== 'string' || !context.evaluationId || !context.limits) {
    throw new Error('Cursor invocation requires a metered context and limits');
  }
  context.signal.throwIfAborted();
  for (const key of ['maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxPaidToolCalls', 'maxRetries', 'timeoutMs'] as const) {
    count(context.limits[key], key);
    if (context.limits[key] > settings.accounting.limits[key]) throw new Error(`Cursor context exceeds ${key} envelope`);
  }
  if (context.limits.maxModelCalls < 1 || context.limits.timeoutMs < 1) throw new Error('Cursor invocation has no available calls or time');
  return { ...context, limits: Object.freeze({ ...context.limits }) };
}

function normalize<O>(result: CursorExecutionResult<O>, settings: CursorSettings, context: RunContext): InvocationResult<O> {
  if (!result || result.complete !== true || result.settled !== true || result.paidToolsUsed !== false || result.singleModel !== true) {
    throw new Error('Cursor requires completed, settled, single-model usage without paid tools');
  }
  if (typeof result.agentId !== 'string' || !result.agentId.trim() || typeof result.runId !== 'string' || !result.runId.trim()) throw new Error('Cursor agent and run ids are required');
  if (result.model !== settings.model) throw new Error('Cursor result differs from the pinned model');
  count(result.modelCalls, 'modelCalls');
  const maxCalls = Math.min(settings.accounting.limits.maxModelCalls, context.limits?.maxModelCalls ?? 0);
  if (result.modelCalls < 1 || result.modelCalls > maxCalls) throw new Error('Cursor model-call count exceeds its enforced limit');
  const scoped = result.usage;
  if (!scoped || !Array.isArray(scoped.runs) || scoped.runs.length !== 1 || scoped.runs[0].runId !== result.runId) throw new Error('Cursor requires exactly one matching run-scoped usage record');
  const usage = checkUsage(scoped.usage), runUsage = checkUsage(scoped.runs[0].usage);
  const cost = checkCost(scoped.cost), runCost = checkCost(scoped.runs[0].cost);
  if (!sameUsage(usage, runUsage) || cost.rawCostCents !== runCost.rawCostCents || cost.chargedCents !== runCost.chargedCents) throw new Error('Cursor scoped and per-run billing differ');
  const price = settings.accounting.pricing;
  const cachedRate = price.cacheReadUSDPerMillion ?? Math.max(price.inputUSDPerMillion, price.outputUSDPerMillion);
  const baseMicros = Math.ceil((usage.inputTokens + usage.cacheWriteTokens) * price.inputUSDPerMillion + usage.cacheReadTokens * cachedRate + usage.outputTokens * price.outputUSDPerMillion);
  const cacheWriteMicros = Math.ceil(usage.cacheWriteTokens * Math.max(0, settings.cacheWriteUSDPerMillion - price.inputUSDPerMillion));
  // Zero costs can mean included or request-priced usage; retain the whole external boundary.
  const billedMicros = cost.rawCostCents === 0 && cost.chargedCents === 0
    ? Math.ceil(settings.boundary.maxCostUSD * 1_000_000)
    : Math.ceil(Math.max(cost.rawCostCents, cost.chargedCents) * 10_000);
  if (![baseMicros, cacheWriteMicros, billedMicros].every(Number.isSafeInteger)) throw new Error('Cursor charge exceeds safe accounting precision');
  const extraMicros = Math.max(cacheWriteMicros, billedMicros - baseMicros, 0);
  const receipt: UsageReceipt = { id: JSON.stringify([result.agentId, result.runId]), provider: 'cursor', model: settings.model,
    inputTokens: usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(extraMicros ? { extraCostUSD: extraMicros / 1_000_000 } : {}) };
  return { output: result.output, usage: { complete: true, receipts: [receipt] }, ...(result.trace ? { trace: result.trace } : {}) };
}

/** Wrap a trusted existing Cursor application; this function does not invoke Cursor itself. */
export function defineCursorAgent<I, O>(options: CursorAgentOptions<I, O>): Agent<I, O> {
  const settings = prepare(options);
  if (typeof options.run !== 'function') throw new Error('Cursor agent callback required');
  const { model: _model, boundary: _boundary, cacheWriteUSDPerMillion: _cache, run, ...agent } = options;
  return defineAgent<I, O>({ ...agent, accounting: structuredClone(settings.accounting), async run(args) {
    const context = checkedContext(args.context, settings);
    return normalize(await run({ ...args, context }), settings, context);
  } });
}

/** Wrap an application-supplied Cursor proposer; no Cursor request is implicit. */
export function createCursorProposer<I, O>(options: CursorProposerOptions<I, O>): Proposer<I, O> {
  const settings = prepare(options);
  if (typeof options.id !== 'string' || !options.id.trim() || typeof options.version !== 'string' || !options.version.trim() || typeof options.propose !== 'function') throw new Error('Cursor proposer identity and callback required');
  const { id, version, propose } = options;
  return { id, version, accounting: structuredClone(settings.accounting), async propose(request, suppliedContext) {
    const context = checkedContext(suppliedContext, settings);
    return normalize(await propose(request, context), settings, context);
  } };
}
