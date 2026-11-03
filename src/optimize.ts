import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Accounting, Agent, Candidate, Components, Evaluation, InvocationResult, LedgerEntry, OptimizationResult, OptimizeOptions, Proposer, RunContext, SearchStrategy } from './types.js';
import { applyPatch, assert, clone, freeze, hash, micros, price, validateAccounting, validateAgent, validateOptions } from './validation.js';
import { defaultRunDirectory, openStore } from './storage.js';

export function defineAgent<I, O>(agent: Agent<I, O>): Agent<I, O> { validateAgent(agent); return agent; }
export function exactMatch<O>({ output, expected }: { output: O; expected: O }): boolean { return isDeepStrictEqual(output, expected); }
export function createOfflineProposer<I = unknown, O = unknown>(patches: readonly Record<string, string>[], id = 'offline'): Proposer<I, O> {
  const saved = clone(patches);
  return { id, version: hash(saved), accounting: { kind: 'free', timeoutMs: 10_000 },
    async propose({ attempt }) { return { output: clone(saved[attempt - 1] ?? {}), usage: { complete: true, receipts: [] } }; } };
}
export const accuracyStrategy: SearchStrategy = {
  id: 'validation-accuracy', version: '1',
  select(candidates, incumbentId) {
    let best = candidates.find(c => c.id === incumbentId)!;
    for (const c of candidates) if (c.validationAccuracy > best.validationAccuracy) best = c;
    return best.id;
  },
};
interface State<O> {
  fingerprint: string; config: unknown; phase: 'baseline' | 'search' | 'test' | 'completed';
  selectedId: string; candidates: Candidate[]; evaluations: Evaluation<O>[];
  history: OptimizationResult<O>['history']; entries: LedgerEntry[];
  calls: Record<string, InvocationResult<unknown>>; nextAttempt: number;
  unrecoverableCalls?: Record<string, string>;
  active?: { attempt: number; candidateId: string };
  schedule?: { candidateId: string; caseId: string }[];
}
class Stop extends Error {}
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
const occupied = (entries: LedgerEntry[]): number => entries.reduce((n, e) => n + (e.status === 'pending' ? e.reservedMicros : e.chargedMicros ?? e.reservedMicros), 0);

export async function optimize<I, O>(options: OptimizeOptions<I, O>): Promise<OptimizationResult<O>> {
  validateOptions(options);
  // Snapshot data/settings while retaining only explicitly supplied callbacks.
  const source = options.agent, d = options.dataset;
  const agent: Agent<I, O> = { ...source, components: freeze(clone(source.components)), mutable: freeze(clone(source.mutable)), accounting: freeze(clone(source.accounting)),
    optimization: { ...source.optimization, proposer: { ...source.optimization.proposer, accounting: freeze(clone(source.optimization.proposer.accounting)) } } };
  const dataset = { ...d, train: clone(d.train), validation: clone(d.validation), test: clone(d.test) };
  const strategy = agent.optimization.strategy ?? accuracyStrategy;
  const cap = micros(options.budget, false), bound = validateAccounting(agent.accounting);
  const holdout = bound * dataset.test.length * 2;
  assert(Number.isSafeInteger(holdout), 'Unsafe holdout reservation');
  assert((dataset.train.length + dataset.validation.length) * bound + holdout <= cap, 'Budget cannot cover baseline and final test envelope');
  assert(!options.run?.resume || options.run.directory, 'Resume requires an explicit directory');
  const config = {
    format: 1, engine: 'evopt-0.1.0', agent: { id: agent.id, version: agent.version, components: agent.components, mutable: agent.mutable, accounting: agent.accounting },
    dataset: { id: dataset.id, version: dataset.version, train: dataset.train, validation: dataset.validation, test: dataset.test },
    proposer: { id: agent.optimization.proposer.id, version: agent.optimization.proposer.version, accounting: agent.optimization.proposer.accounting },
    strategy: { id: strategy.id, version: strategy.version }, attempts: agent.optimization.maxAttempts ?? 10,
    objective: options.objective, cap, includeTraces: options.run?.includeTraces ?? false,
  };
  const fingerprint = hash(config), baseId = hash(agent.components);
  const directory = resolve(options.run?.directory ?? defaultRunDirectory());
  const store = await openStore<State<O>>(directory, { fingerprint, config, phase: 'baseline', selectedId: baseId,
    candidates: [{ id: baseId, components: agent.components }], evaluations: [], history: [], entries: [], calls: {}, nextAttempt: 1 }, options.run?.resume ?? false);
  const s = store.state;
  try {
    assert(s.fingerprint === fingerprint, 'Run fingerprint mismatch; use a new directory');
    assert(!s.entries.some(e => e.status !== 'settled'), 'Unresolved billing or envelope violation; automatic resume refused');
    assert(!Object.keys(s.unrecoverableCalls ?? {}).length, 'Invocation output could not be saved; automatic resume refused to avoid repeating completed work');
    const find = (id: string): Candidate => s.candidates.find(c => c.id === id)!;
    const remainingHoldout = (): number => s.phase === 'test'
      ? (s.schedule ?? []).filter(x => !s.calls[`eval:${x.candidateId}:test:${x.caseId}`]).length * bound : holdout;
    async function invoke<T>(key: string, purpose: string, accounting: Accounting, fn: (context: RunContext) => Promise<InvocationResult<T>>): Promise<InvocationResult<T>> {
      if (options.run?.signal?.aborted) throw new Stop('Cancelled');
      if (Object.hasOwn(s.calls, key)) return clone(s.calls[key]) as InvocationResult<T>;
      const reserved = validateAccounting(accounting);
      const protection = s.phase === 'test' ? Math.max(0, remainingHoldout() - reserved) : holdout;
      if (occupied(s.entries) + reserved + protection > cap) throw new Stop('Budget exhausted');
      const id = randomUUID(), entry: LedgerEntry = { id, purpose, reservedMicros: reserved, status: 'pending' };
      s.entries.push(entry); await store.save();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const external = (): void => controller.abort(new Stop('Cancelled'));
      options.run?.signal?.addEventListener('abort', external, { once: true });
      if (options.run?.signal?.aborted) external();
      const timeoutMs = accounting.kind === 'paid' ? accounting.limits.timeoutMs : accounting.timeoutMs;
      const context: RunContext = { signal: controller.signal, evaluationId: id, ...(accounting.kind === 'paid' ? { limits: freeze(clone(accounting.limits)) } : {}) };
      try {
        const cancelled = new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          timer = setTimeout(() => controller.abort(new Stop('Invocation timed out')), timeoutMs);
        });
        const result = await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; return fn(context); }), cancelled]);
        assert(result?.usage?.complete === true, 'Incomplete usage; reservation retained');
        if (accounting.kind === 'free' && Array.isArray(result.usage.receipts) && result.usage.receipts.some(r => r && (r.inputTokens > 0 || r.outputTokens > 0 || (r.extraCostUSD ?? 0) > 0))) {
          entry.status = 'envelope_violation';
          entry.receipts = clone(result.usage.receipts);
          entry.chargedMicros = result.usage.receipts.reduce((sum, r) => sum + micros(r.extraCostUSD ?? 0), 0);
          throw new Stop('Free integration reported paid usage: token cost is unknown; known extra charges recorded');
        }
        const charged = price(accounting, result.usage.receipts);
        const seenReceipts = new Set(s.entries.filter(e => e !== entry).flatMap(e => (e.receipts ?? []).map(r => `${r.provider}:${r.id}`)));
        assert(!result.usage.receipts.some(r => seenReceipts.has(`${r.provider}:${r.id}`)), 'Receipt reused across invocations');
        entry.chargedMicros = charged; entry.receipts = clone(result.usage.receipts);
        const exceedsLimits = accounting.kind === 'paid' && (
          result.usage.receipts.reduce((n,r) => n + r.inputTokens, 0) > accounting.limits.maxInputTokens ||
          result.usage.receipts.reduce((n,r) => n + r.outputTokens, 0) > accounting.limits.maxOutputTokens ||
          result.usage.receipts.filter(r => r.inputTokens + r.outputTokens > 0).length > accounting.limits.maxModelCalls);
        entry.status = charged > reserved || exceedsLimits ? 'envelope_violation' : 'settled';
        if (entry.status === 'envelope_violation') throw new Stop('Adapter exceeded its declared envelope');
        let stored: InvocationResult<T>;
        try {
          stored = { output: clone(result.output), usage: clone(result.usage) };
          if (options.run?.includeTraces && result.trace) stored.trace = clone(result.trace);
        } catch (error) {
          // Known billing must survive an invalid output without allowing that
          // completed invocation to be repeated on recovery.
          (s.unrecoverableCalls ??= {})[key] = message(error);
          throw error;
        }
        // Settlement and its replayable result form one durable snapshot. A
        // crash before this write leaves the original reservation pending.
        s.calls[key] = stored; await store.save(); return clone(stored);
      } catch (error) {
        // A free invocation has no unknown financial exposure, but still stops this run.
        if (accounting.kind === 'free' && entry.status === 'pending') { entry.status = 'settled'; entry.chargedMicros = 0; }
        await store.save(); throw new Stop(message(error));
      } finally {
        if (timer) clearTimeout(timer); options.run?.signal?.removeEventListener('abort', external);
      }
    }
    async function evaluate(candidateId: string, split: 'train' | 'validation' | 'test', caseId?: string): Promise<void> {
      for (const c of dataset[split]) {
        if (options.run?.signal?.aborted) throw new Stop('Cancelled');
        if (caseId && c.id !== caseId) continue;
        if (s.evaluations.some(e => e.candidateId === candidateId && e.split === split && e.caseId === c.id)) continue;
        const key = `eval:${candidateId}:${split}:${c.id}`;
        const r = await invoke(key, key, agent.accounting, context => agent.run({ input: clone(c.input), components: freeze(clone(find(candidateId).components)), context }));
        let passed: boolean;
        const signal = options.run?.signal;
        let onAbort: (() => void) | undefined;
        try {
          const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(new Stop('Cancelled'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          passed = await Promise.race([
            Promise.resolve().then(() => {
              if (signal?.aborted) throw new Stop('Cancelled');
              return dataset.score({ input: clone(c.input), output: clone(r.output), expected: clone(c.expected) });
            }),
            cancelled,
          ]);
          if (signal?.aborted) throw new Stop('Cancelled');
          assert(typeof passed === 'boolean', 'Scorer must return boolean');
        }
        catch (e) { throw new Stop(`Scorer failed: ${message(e)}`); }
        finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
        const entry = s.entries.findLast(e => e.purpose === key)!;
        s.evaluations.push({ id: entry.id, candidateId, caseId: c.id, split, output: r.output, passed, usage: r.usage.receipts, ...(r.trace ? { trace: r.trace } : {}) });
        await store.save();
      }
      if (split !== 'test') {
        const rows = s.evaluations.filter(e => e.candidateId === candidateId && e.split === split);
        if (rows.length === dataset[split].length) find(candidateId)[split === 'train' ? 'trainAccuracy' : 'validationAccuracy'] = rows.filter(e => e.passed).length / rows.length;
        await store.save();
      }
    }
    let reason: string | undefined;
    try {
      if (s.phase === 'baseline') {
        await evaluate(baseId, 'train'); await evaluate(baseId, 'validation'); s.phase = 'search'; await store.save();
      }
      if (s.phase === 'search') {
        for (; s.nextAttempt <= config.attempts;) {
          if (!s.active) {
            // Do not pay for a proposal unless its full candidate evaluation can also fit.
            const need = validateAccounting(agent.optimization.proposer.accounting) + bound * (dataset.train.length + dataset.validation.length);
            if (occupied(s.entries) + holdout + need > cap) break;
            const attempt = s.nextAttempt, incumbent = find(s.selectedId);
            const feedback = s.evaluations.filter(e => e.candidateId === incumbent.id && e.split === 'train').map(e => {
              const c = dataset.train.find(c => c.id === e.caseId)!;
              return { caseId: c.id, input: clone(c.input), expected: clone(c.expected), output: clone(e.output), passed: e.passed };
            });
            const proposed = await invoke(`proposal:${attempt}`, 'proposal', agent.optimization.proposer.accounting, context => agent.optimization.proposer.propose({
              components: freeze(Object.fromEntries(Object.keys(agent.mutable).map(k => [k, incumbent.components[k]!]))), mutable: agent.mutable, feedback, attempt,
            }, context));
            try {
              const components = applyPatch(incumbent.components, agent.mutable, proposed.output), id = hash(components);
              if (s.candidates.some(c => c.id === id)) throw new Error('Duplicate candidate');
              s.candidates.push({ id, components }); s.active = { attempt, candidateId: id }; await store.save();
            } catch (e) {
              s.history.push({ attempt, status: 'rejected', reason: message(e) }); s.nextAttempt++; await store.save(); continue;
            }
          }
          const active = s.active!;
          await evaluate(active.candidateId, 'train'); await evaluate(active.candidateId, 'validation');
          const eligible = s.candidates.filter(c => c.trainAccuracy !== undefined && c.validationAccuracy !== undefined).map(c => ({ id: c.id, trainAccuracy: c.trainAccuracy!, validationAccuracy: c.validationAccuracy! }));
          const selected = strategy.select(freeze(clone(eligible)), s.selectedId);
          assert(eligible.some(c => c.id === selected), 'Strategy selected an unevaluated candidate');
          assert(find(selected).validationAccuracy! >= find(s.selectedId).validationAccuracy!, 'Strategy degraded validation accuracy');
          if (find(selected).validationAccuracy! > find(s.selectedId).validationAccuracy!) s.selectedId = selected;
          s.history.push({ attempt: active.attempt, status: 'evaluated', candidateId: active.candidateId });
          s.nextAttempt++; delete s.active; await store.save();
        }
        s.phase = 'test';
        s.schedule = dataset.test.flatMap((c, i) => (s.selectedId === baseId ? [baseId] : i % 2 === 0 ? [baseId, s.selectedId] : [s.selectedId, baseId]).map(candidateId => ({ candidateId, caseId: c.id })));
        await store.save();
      }
      if (s.phase === 'test') {
        for (const row of s.schedule!) await evaluate(row.candidateId, 'test', row.caseId);
        s.phase = 'completed'; await store.save();
      }
    } catch (e) { reason = message(e); }
    const selected = find(s.selectedId);
    const testAccuracy = (id: string): number => { const rows = s.evaluations.filter(e => e.split === 'test' && e.candidateId === id); return rows.filter(e => e.passed).length / rows.length; };
    return clone({ status: s.phase === 'completed' ? 'completed' : 'interrupted', ...(reason ? { reason } : {}), directory,
      components: selected.components, selectedId: selected.id,
      changes: Object.fromEntries(Object.keys(agent.mutable).filter(k => selected.components[k] !== agent.components[k]).map(k => [k, { before: agent.components[k]!, after: selected.components[k]! }])),
      candidates: s.candidates, history: s.history, evaluations: s.evaluations,
      ...(s.phase === 'completed' ? { test: { kind: s.selectedId === baseId ? 'identity-control' : 'paired', baselineAccuracy: testAccuracy(baseId), candidateAccuracy: testAccuracy(s.selectedId) } } : {}),
      accounting: { currency: 'USD', limitMicros: cap, occupiedMicros: occupied(s.entries), entries: s.entries },
      provenance: { agentId: agent.id, agentVersion: agent.version, datasetId: dataset.id, datasetVersion: dataset.version, fingerprint, synthetic: agent.accounting.kind === 'free' && agent.optimization.proposer.accounting.kind === 'free' },
    } as OptimizationResult<O>);
  } finally { await store.close(); }
}
