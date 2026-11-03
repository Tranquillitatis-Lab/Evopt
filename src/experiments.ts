import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, Dataset, OptimizationResult } from './types.js';
import { optimize } from './optimize.js';
import { assert, canonical, hash, micros, text, validateOptions, validateAccounting, record } from './validation.js';

/** A trusted application module. Importing it must not perform inference. */
export interface Experiment<I, O> {
  id: string; description: string; agent: Agent<I, O>; dataset: Dataset<I, O>; objective: 'accuracy';
}
export function defineExperiment<I, O>(experiment: Experiment<I, O>): Experiment<I, O> {
  checkExperiment(experiment); return experiment;
}
export function checkExperiment<I, O>(experiment: Experiment<I, O>, budget?: number) {
  assert(record(experiment), 'Missing experiment'); text(experiment.id); text(experiment.description);
  // This is shape validation only; the internal value is never a spending authorization.
  validateOptions({ ...experiment, budget: budget ?? 1 });
  const target = validateAccounting(experiment.agent.accounting);
  const proposer = validateAccounting(experiment.agent.optimization.proposer.accounting);
  const attempts = experiment.agent.optimization.maxAttempts ?? 10;
  const baseline = (experiment.dataset.train.length + experiment.dataset.validation.length) * target;
  const holdout = experiment.dataset.test.length * 2 * target;
  const search = attempts * (proposer + baseline);
  assert(Number.isSafeInteger(baseline + holdout + search), 'Unsafe experiment cost bounds');
  return {
    id: experiment.id, agentId: experiment.agent.id, datasetId: experiment.dataset.id,
    paid: experiment.agent.accounting.kind === 'paid' || experiment.agent.optimization.proposer.accounting.kind === 'paid',
    inferenceRun: false, attempts, cases: { train: experiment.dataset.train.length, validation: experiment.dataset.validation.length, test: experiment.dataset.test.length },
    currency: 'USD' as const, minimumMicros: baseline + holdout, plannedMaximumMicros: baseline + holdout + search,
    ...(budget !== undefined ? { limitMicros: micros(budget, false), minimumFits: baseline + holdout <= micros(budget, false), plannedFits: baseline + holdout + search <= micros(budget, false) } : {}),
  };
}

export interface ExperimentRunOptions {
  budget: number; directory: string; allowPaid?: boolean; resume?: boolean; signal?: AbortSignal;
}
export async function runExperiment<I, O>(experiment: Experiment<I, O>, options: ExperimentRunOptions): Promise<OptimizationResult<O>> {
  const check = checkExperiment(experiment, options.budget);
  assert(!check.paid || options.allowPaid === true, 'Paid experiments require explicit --allow-paid and --budget authorization');
  assert(check.minimumFits, 'Budget cannot cover baseline and final test envelope');
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
      run: { directory, resume: options.resume, signal: options.signal } });
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
  return {
    directory: resolve(directory), phase: s.phase, selectedId: s.selectedId,
    evaluations: s.evaluations.length, attemptsFinished: Array.isArray(s.history) ? s.history.length : 0,
    occupiedMicros: entries.reduce((n,e) => n + (e.status === 'pending' ? e.reservedMicros : e.chargedMicros ?? e.reservedMicros), 0),
    pending: entries.some(e => e.status === 'pending'), envelopeViolation: entries.some(e => e.status === 'envelope_violation'),
    unrecoverable: Object.keys((s.unrecoverableCalls ?? {}) as object).length > 0,
    note: 'Checkpoint only; an interrupted journal may contain a newer reservation. Resume performs recovery; never clear billing from this summary.',
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
  }), 'Result and checkpoint provenance differ');
  return result;
}

/** Exclusive write: reviewed artifacts and experiment scaffolds are never silently replaced. */
export async function writeNewFile(path: string, contents: string): Promise<void> {
  const target = resolve(path); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
}
