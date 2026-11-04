import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from './common.ts';

interface EvaluationRecord {
  task: string;
  taskId?: string;
  repetition?: number;
  evaluationId?: string;
  success: boolean;
  safety: boolean;
  tokens: number;
  steps?: number;
  toolCounts?: Record<string, number>;
}

interface ScoredCandidate { id: string; results: EvaluationRecord[] }

/** Only training observations are available to a proposer. */
export function trainingFeedback(state: {
  evaluations: Record<string, EvaluationRecord>;
  history: { generation: number; training?: unknown }[];
  rejections?: { reason: string }[];
}, baselineId: string, limit = 12) {
  const rows = [];
  for (const [key, result] of Object.entries(state.evaluations)) {
    const [candidateId, split, task] = key.split('/');
    if (split !== 'train') continue;
    const baseline = state.evaluations[`${baselineId}/train/${task}`];
    if (!baseline) continue;
    rows.push({ candidateId, task, success: result.success, baselineSuccess: baseline.success, safety: result.safety,
      tokens: result.tokens, baselineTokens: baseline.tokens, tokenDelta: result.tokens - baseline.tokens,
      modelSteps: result.steps ?? null, toolCounts: result.toolCounts ?? null });
  }
  rows.sort((a, b) => Number(b.baselineSuccess && !b.success) - Number(a.baselineSuccess && !a.success)
    || Math.abs(b.tokenDelta) - Math.abs(a.tokenDelta)
    || String(a.candidateId).localeCompare(String(b.candidateId)) || String(a.task).localeCompare(String(b.task)));
  return { version: 1, scope: 'train-only', observations: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit),
    generations: state.history.slice(-3).map(row => ({ generation: row.generation, training: row.training })),
    rejections: (state.rejections ?? []).slice(-5).map(row => ({ reason: row.reason })) };
}

export function comparison(reference: ScoredCandidate, candidate: ScoredCandidate) {
  const baselineSelected = reference.id === candidate.id;
  return { comparisonKind: baselineSelected ? 'identity-control' : 'paired-task-single-observation',
    baselineSelected, independentArms: !baselineSelected,
    pairs: reference.results.map(before => {
      const after = candidate.results.find(result => result.task === before.task);
      assert(after, 'Missing candidate task in pair');
      return { task: before.taskId ?? before.task, trialId: before.task, repetition: before.repetition ?? 0,
        baselineEvaluationId: before.evaluationId ?? `${reference.id}/test/${before.task}`,
        candidateEvaluationId: after.evaluationId ?? `${candidate.id}/test/${before.task}`,
        reusedEvaluation: baselineSelected, baselineTokens: before.tokens, candidateTokens: after.tokens,
        tokenDelta: after.tokens - before.tokens, baselineSuccess: before.success, candidateSuccess: after.success };
    }), limitations: ['sampling-uncontrolled', 'cache-uncontrolled', ...(baselineSelected ? ['same-evaluation-not-an-independent-ab-test'] : [])] };
}

/** Produce a private summary without running an agent or copying its raw outputs. */
export async function analyzeRun(runDir: string, out: string) {
  const root = await realpath(runDir);
  const parent = await realpath(path.dirname(path.resolve(out)));
  const relative = path.relative(root, path.join(parent, path.basename(out)));
  assert(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'Analysis output must be outside the run directory');
  const lanes = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    try {
      const state = JSON.parse(await readFile(path.join(root, entry.name, 'state.json'), 'utf8'));
      lanes.push({ id: entry.name, generation: state.generation, winner: state.winner, final: state.final ?? null,
        evaluations: Object.keys(state.evaluations ?? {}).length, history: state.history ?? [], rejections: state.rejections ?? [] });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  assert(lanes.length > 0, 'No lane state files found');
  let budget = null;
  try { budget = JSON.parse(await readFile(path.join(root, 'budget.json'), 'utf8')).budget; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const analysis = { version: 1, visibility: 'private-unreviewed', budget, lanes, inferenceRun: false };
  await writeFile(out, JSON.stringify(analysis, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { destination: path.resolve(out), lanes: lanes.length, inferenceRun: false };
}
