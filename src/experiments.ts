import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, Dataset, OptimizationObjective, OptimizationResult } from './types.js';
import { optimize } from './optimize.js';
import { assert, canonical, hash, micros, text, validateOptions, validateAccounting, record } from './validation.js';
import { normalizeObjective, resolveSelectionPolicy } from './selection.js';
import { tokenEnvelope, usageTokens } from './tokens.js';

/** A trusted application module. Importing it must not perform inference. */
export interface Experiment<I, O> {
  id: string; description: string; agent: Agent<I, O>; dataset: Dataset<I, O>; objective?: OptimizationObjective;
}
export function defineExperiment<I, O>(experiment: Experiment<I, O>): Experiment<I, O> {
  checkExperiment(experiment); return experiment;
}
export function checkExperiment<I, O>(experiment: Experiment<I, O>, budget?: number, maxTokens?: number) {
  assert(record(experiment), 'Missing experiment'); text(experiment.id); text(experiment.description);
  // This is shape validation only; the internal value is never a spending authorization.
  validateOptions({ ...experiment, budget: budget ?? 1, ...(maxTokens === undefined ? {} : { run: { maxTokens } }) });
  const target = validateAccounting(experiment.agent.accounting);
  const proposer = validateAccounting(experiment.agent.optimization.proposer.accounting);
  const attempts = experiment.agent.optimization.maxAttempts ?? 10;
  const baseline = (experiment.dataset.train.length + experiment.dataset.validation.length) * target;
  const holdout = experiment.dataset.test.length * 2 * target;
  const search = attempts * (proposer + baseline);
  const targetTokens = tokenEnvelope(experiment.agent.accounting), proposalTokens = tokenEnvelope(experiment.agent.optimization.proposer.accounting);
  const minimumTokens = (experiment.dataset.train.length + experiment.dataset.validation.length + experiment.dataset.test.length * 2) * targetTokens;
  const plannedMaximumTokens = minimumTokens + attempts * (proposalTokens + (experiment.dataset.train.length + experiment.dataset.validation.length) * targetTokens);
  assert(Number.isSafeInteger(minimumTokens) && Number.isSafeInteger(plannedMaximumTokens), 'Unsafe experiment token bounds');
  assert(Number.isSafeInteger(baseline + holdout + search), 'Unsafe experiment cost bounds');
  return {
    id: experiment.id, agentId: experiment.agent.id, datasetId: experiment.dataset.id,
    objective: normalizeObjective(experiment.objective), selection: resolveSelectionPolicy(normalizeObjective(experiment.objective), experiment.agent.optimization.selection),
    paid: experiment.agent.accounting.kind === 'paid' || experiment.agent.optimization.proposer.accounting.kind === 'paid',
    inferenceRun: false, attempts, cases: { train: experiment.dataset.train.length, validation: experiment.dataset.validation.length, test: experiment.dataset.test.length },
    currency: 'USD' as const, minimumMicros: baseline + holdout, plannedMaximumMicros: baseline + holdout + search,
    minimumTokens, plannedMaximumTokens,
    ...(maxTokens === undefined ? {} : { maxTokens, tokenMinimumFits: minimumTokens <= maxTokens, tokenPlannedFits: plannedMaximumTokens <= maxTokens }),
    ...(budget !== undefined ? { limitMicros: micros(budget, false), minimumFits: baseline + holdout <= micros(budget, false), plannedFits: baseline + holdout + search <= micros(budget, false) } : {}),
  };
}

export interface ExperimentRunOptions {
  budget: number; directory: string; allowPaid?: boolean; resume?: boolean; signal?: AbortSignal;
  maxTokens?: number;
}
export async function runExperiment<I, O>(experiment: Experiment<I, O>, options: ExperimentRunOptions): Promise<OptimizationResult<O>> {
  const check = checkExperiment(experiment, options.budget, options.maxTokens);
  assert(!check.paid || options.allowPaid === true, 'Paid experiments require explicit --allow-paid and --budget authorization');
  assert(check.minimumFits, 'Budget cannot cover baseline and final test envelope');
  assert(check.tokenMinimumFits !== false, 'Token ceiling cannot cover baseline and final test envelope');
  text(options.directory);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  // Hold a workflow lock until result.json is persisted, extending the core run lock.
  const lockPath = join(directory, 'experiment.lock');
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Experiment locked; inspect its owner before manual recovery'); throw e; }
  const temporary = join(directory, `.result-${randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token })); await lock.sync();
    const result = await optimize({ agent: experiment.agent, dataset: experiment.dataset, objective: experiment.objective, budget: options.budget,
      run: { directory, resume: options.resume, signal: options.signal, ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) } });
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(result, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, 'result.json'));
    return result;
  } finally {
    await lock.close();
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (owner.token === token) await unlink(lockPath);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

/** Read-only checkpoint summary: never imports an adapter or dispatches inference. */
export async function experimentStatus(directory: string) {
  const snapshot = JSON.parse(await readFile(join(resolve(directory), 'state.json'), 'utf8'));
  const s = snapshot.state;
  assert(snapshot.version === 1 && record(s) && Array.isArray(s.entries) && Array.isArray(s.evaluations), 'Invalid run checkpoint');
  const entries = s.entries as OptimizationResult<unknown>['accounting']['entries'];
  let tokenProgress: { maxTokens: number; occupiedTokens: number } | undefined;
  if (record(s.config) && s.config.maxTokens !== undefined) {
    const maximum = s.config.maxTokens;
    assert(typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0, 'Invalid checkpoint token ceiling');
    let total = 0;
    for (const entry of entries) {
      assert(record(entry) && ['pending', 'settled', 'envelope_violation'].includes(entry.status), 'Invalid checkpoint token entry');
      if (entry.status === 'pending') {
        assert(entry.purpose === 'proposal' || entry.purpose.startsWith('eval:'), 'Unsupported pending invocation purpose');
        const integration = entry.purpose === 'proposal' ? s.config.proposer : s.config.agent;
        assert(record(integration) && record(integration.accounting), 'Missing checkpoint invocation accounting');
        const accounting = integration.accounting as unknown as Parameters<typeof tokenEnvelope>[0];
        validateAccounting(accounting);
        total += tokenEnvelope(accounting);
      } else total += usageTokens(entry.receipts ?? []);
      assert(Number.isSafeInteger(total) && total >= 0, 'Unsafe checkpoint token total');
    }
    tokenProgress = { maxTokens: maximum, occupiedTokens: total };
  }
  return {
    directory: resolve(directory), phase: s.phase, selectedId: s.selectedId,
    evaluations: s.evaluations.length, attemptsFinished: Array.isArray(s.history) ? s.history.length : 0,
    occupiedMicros: entries.reduce((n,e) => n + (e.status === 'pending' ? e.reservedMicros : e.chargedMicros ?? e.reservedMicros), 0),
    ...(tokenProgress ?? {}),
    pending: entries.some(e => e.status === 'pending'), envelopeViolation: entries.some(e => e.status === 'envelope_violation'),
    unrecoverable: Object.keys((s.unrecoverableCalls ?? {}) as object).length > 0,
    note: 'Checkpoint only; an interrupted journal may contain a newer reservation. Resume performs recovery; never clear billing from this summary.'
      + (tokenProgress ? ' occupiedTokens includes recorded usage plus the full configured target/proposer token envelope for each pending invocation; partial pending receipts do not release reservations.' : ''),
  };
}
export async function readExperimentResult(directory: string): Promise<OptimizationResult<unknown>> {
  const root = resolve(directory);
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as OptimizationResult<unknown>;
  const snapshot = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  const s = snapshot.state;
  assert(s?.phase === 'completed' && result.status === 'completed', 'Only completed runs can be exported');
  assert(hash(s.config) === s.fingerprint && s.fingerprint === result.provenance?.fingerprint, 'Result and checkpoint fingerprints differ');
  assert(canonical(s.entries) === canonical(result.accounting.entries), 'Result and checkpoint accounting differ');
  for (const key of ['candidates', 'history', 'evaluations', 'selectedId'] as const) {
    assert(canonical(s[key]) === canonical(result[key]), `Result and checkpoint ${key} differ`);
  }
  assert(result.accounting.limitMicros === s.config.cap && result.accounting.currency === 'USD', 'Result and checkpoint budget differ');
  assert(canonical(result.provenance) === canonical({
    agentId: s.config.agent.id, agentVersion: s.config.agent.version,
    datasetId: s.config.dataset.id, datasetVersion: s.config.dataset.version,
    fingerprint: s.fingerprint, synthetic: s.config.agent.accounting.kind === 'free' && s.config.proposer.accounting.kind === 'free',
    ...(s.config.dataset.benchmark ? { benchmark: s.config.dataset.benchmark } : {}),
  }), 'Result and checkpoint provenance differ');
  if ([1, 2, 3].includes(s.config.exportContract)) assert(result.configuration !== undefined, 'Result is missing its configuration contract');
  if (result.configuration !== undefined) assert(canonical(result.configuration) === canonical({ mutable: s.config.agent.mutable,
    ...(s.config.agent.structure ? { structure: s.config.agent.structure } : {}),
    ...(s.config.exportContract >= 3 ? { objective: s.config.objective } : {}),
    ...(s.config.selection ? { selection: s.config.selection } : {}), ...(s.config.experience ? { experience: s.config.experience } : {}) }), 'Result and checkpoint configuration differ');
  assert(result.accounting.maxTokens === s.config.maxTokens, 'Result and checkpoint token ceiling differ');
  if (s.config.maxTokens !== undefined) assert(result.accounting.occupiedTokens === s.entries.reduce((sum: number, entry: { receipts?: import('./types.js').UsageReceipt[] }) => sum + usageTokens(entry.receipts ?? []), 0), 'Result and checkpoint token usage differ');
  else assert(result.accounting.occupiedTokens === undefined, 'Unexpected token ceiling accounting');
  return result;
}

/** Exclusive write: reviewed artifacts and experiment scaffolds are never silently replaced. */
export async function writeNewFile(path: string, contents: string): Promise<void> {
  const target = resolve(path); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
}
