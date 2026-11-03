import { createHash } from 'node:crypto';
import type { Accounting, Agent, BenchmarkProvenance, Components, OptimizeOptions, UsageReceipt } from './types.js';
import { validateStructure } from './structure.js';

export function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
}
export function integer(x: unknown, min = 0): asserts x is number { assert(Number.isSafeInteger(x) && (x as number) >= min, 'Expected safe integer'); }
export function text(x: unknown): asserts x is string { assert(typeof x === 'string' && x.trim().length > 0, 'Expected nonempty string'); }
export function micros(x: number, ceiling = true): number {
  assert(typeof x === 'number' && Number.isFinite(x) && x >= 0, 'Invalid USD amount');
  const n = ceiling ? Math.ceil(x * 1e6) : Math.floor(x * 1e6); integer(n); return n;
}
/** Canonical JSON is also the v1 data contract; unsupported values fail before execution. */
export function canonical(x: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { assert(Number.isFinite(v), 'Data must contain finite numbers'); return v; }
    assert(typeof v === 'object' && v !== null && !seen.has(v), 'Data must be acyclic JSON');
    seen.add(v);
    let result: unknown;
    if (Array.isArray(v)) {
      assert(Object.keys(v).length === v.length, 'Sparse arrays are unsupported'); result = v.map(visit);
    } else {
      assert(record(v), 'Data must be plain JSON objects');
      result = Object.fromEntries(Object.keys(v).sort().map(k => [k, visit(v[k])]));
    }
    seen.delete(v); return result;
  }
  return JSON.stringify(visit(x));
}
export const hash = (x: unknown): string => createHash('sha256').update(canonical(x)).digest('hex');
export const clone = <T>(x: T): T => JSON.parse(canonical(x)) as T;
export function freeze<T>(x: T): T {
  if (x && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) freeze(v); } return x;
}
export function validateAccounting(a: Accounting): number {
  assert(record(a), 'Missing accounting contract');
  if (a.kind === 'free') { integer(a.timeoutMs, 1); return 0; }
  assert(a.kind === 'paid', 'Unmetered paid integration');
  text(a.enforcement); text(a.version); assert(record(a.limits), 'Missing invocation limits');
  for (const k of ['maxModelCalls','maxInputTokens','maxOutputTokens','maxPaidToolCalls','maxRetries'] as const) integer(a.limits[k]);
  integer(a.limits.timeoutMs, 1);
  const p = a.pricing; assert(record(p), 'Missing pricing'); text(p.source); text(p.checkedAt);
  assert(Number.isFinite(Date.parse(p.checkedAt)), 'Invalid pricing date');
  for (const n of [p.inputUSDPerMillion, p.outputUSDPerMillion, p.cacheReadUSDPerMillion ?? 0]) assert(typeof n === 'number' && Number.isFinite(n) && n >= 0, 'Invalid price');
  const bound = micros(a.maxCostUSD); assert(bound > 0, 'Paid envelope must be positive');
  const tokens = Math.ceil(a.limits.maxInputTokens * Math.max(p.inputUSDPerMillion, p.cacheReadUSDPerMillion ?? Math.max(p.inputUSDPerMillion, p.outputUSDPerMillion)) + a.limits.maxOutputTokens * p.outputUSDPerMillion);
  integer(tokens); assert(bound >= tokens, 'Envelope does not cover token limits'); return bound;
}
export function price(a: Accounting, receipts: UsageReceipt[]): number {
  assert(Array.isArray(receipts), 'Missing normalized receipts');
  if (a.kind === 'paid') assert(receipts.length > 0, 'Paid invocation requires receipts');
  const ids = new Set<string>(); let extras = 0, inputs = 0, outputs = 0, cached = 0;
  for (const r of receipts) {
    assert(record(r), 'Invalid receipt'); text(r.id); text(r.provider); text(r.model);
    assert(!ids.has(r.id), 'Duplicate receipt'); ids.add(r.id);
    integer(r.inputTokens); integer(r.outputTokens); integer(r.cachedInputTokens);
    assert(r.cachedInputTokens <= r.inputTokens, 'Cache tokens must be input subset');
    if (r.reasoningTokens !== undefined) { integer(r.reasoningTokens); assert(r.reasoningTokens <= r.outputTokens, 'Reasoning must be output subset'); }
    const extra = micros(r.extraCostUSD ?? 0);
    inputs += r.inputTokens; outputs += r.outputTokens; cached += r.cachedInputTokens; extras += extra;
    integer(inputs); integer(outputs); integer(cached); integer(extras);
    if (a.kind === 'free') assert(inputs === 0 && outputs === 0 && extra === 0, 'Free integration reported paid usage');
  }
  if (a.kind === 'free') return 0;
  const p = a.pricing;
  const rounded = Math.ceil((inputs - cached) * p.inputUSDPerMillion + cached * (p.cacheReadUSDPerMillion ?? Math.max(p.inputUSDPerMillion, p.outputUSDPerMillion)) + outputs * p.outputUSDPerMillion) + extras;
  integer(rounded); return rounded;
}
export function validateAgent<I, O>(a: Agent<I, O>): void {
  assert(record(a), 'Missing agent'); text(a.id); text(a.version);
  validateStructure(a);
  assert(typeof a.run === 'function', 'Missing runner'); validateAccounting(a.accounting);
  assert(record(a.optimization), 'Missing optimization settings'); const p = a.optimization.proposer;
  assert(record(p) && typeof p.propose === 'function', 'Missing proposer'); text(p.id); text(p.version); validateAccounting(p.accounting);
  integer(a.optimization.maxAttempts ?? 10);
  if (a.optimization.strategy) { text(a.optimization.strategy.id); text(a.optimization.strategy.version); assert(typeof a.optimization.strategy.select === 'function', 'Invalid strategy'); }
}
export function validateOptions<I, O>(o: OptimizeOptions<I, O>): void {
  assert(record(o), 'Missing options'); validateAgent(o.agent);
  assert(o.objective === 'accuracy', 'Unsupported objective'); assert(micros(o.budget, false) > 0, 'Budget must be at least one USD micro-unit');
  const d = o.dataset; assert(record(d), 'Missing dataset'); text(d.id); text(d.version); assert(typeof d.score === 'function', 'Missing local scorer');
  if (d.benchmark !== undefined) validateBenchmarkProvenance(d.benchmark);
  const ids = new Set<string>(); const inputs = new Map<string,string>();
  for (const split of ['train','validation','test'] as const) {
    assert(Array.isArray(d[split]) && d[split].length > 0, 'Partitions must be nonempty');
    for (const c of d[split]) {
      assert(record(c) && Object.hasOwn(c, 'input') && Object.hasOwn(c, 'expected'), 'Malformed case'); text(c.id);
      assert(!ids.has(c.id), 'Duplicate case identity'); ids.add(c.id);
      const key = canonical(c.input); canonical(c.expected);
      assert(!inputs.has(key) || inputs.get(key) === split, 'Input duplicated across partitions'); inputs.set(key, split);
    }
  }
}
export function validateBenchmarkProvenance(value: unknown): asserts value is BenchmarkProvenance {
  assert(record(value), 'Invalid benchmark provenance'); text(value.id); text(value.metric);
  assert(Object.keys(value).every(k => ['id','sourceRevision','sourceSha256','manifestSha256','metric','splitPolicy','evaluator'].includes(k)), 'Unexpected benchmark metadata');
  assert(value.splitPolicy === 'custom-disjoint', 'Unsupported benchmark split policy');
  for (const key of ['sourceSha256', 'manifestSha256']) assert(typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]), 'Invalid benchmark digest');
  assert(typeof value.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(value.sourceRevision), 'Invalid source revision');
  assert(record(value.evaluator), 'Missing benchmark evaluator'); text(value.evaluator.name);
  assert(Object.keys(value.evaluator).every(k => ['name','revision'].includes(k)), 'Unexpected evaluator metadata');
  assert(typeof value.evaluator.revision === 'string' && /^[a-f0-9]{40}$/.test(value.evaluator.revision), 'Invalid evaluator revision');
}
export function applyPatch(components: Components, mutable: Agent<unknown, unknown>['mutable'], patch: unknown): Components {
  assert(record(patch) && Object.keys(patch).length > 0, 'Proposal must contain text edits');
  const next = { ...components };
  for (const [key, value] of Object.entries(patch)) {
    assert(Object.hasOwn(mutable, key), 'Proposal changes immutable component');
    assert(typeof value === 'string' && value.length <= mutable[key]!.maxLength, 'Invalid or oversized component'); next[key] = value;
  }
  return freeze(next);
}
