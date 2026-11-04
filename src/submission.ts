import { readFile } from 'node:fs/promises';
import { assert, hash } from './common.ts';

/** Recompute a portable result from its paired observations. */
export async function verifySubmission(file: string) {
  const submission = JSON.parse(await readFile(file, 'utf8'));
  assert(submission?.version === 1 && typeof submission.lane === 'string' && typeof submission.fingerprint === 'string', 'Invalid submission identity');
  const { digest, ...payload } = submission;
  assert(typeof digest === 'string' && digest === hash(payload), 'Submission digest differs from its contents');
  assert(submission.genome && typeof submission.genome === 'object' && !Array.isArray(submission.genome), 'Missing candidate text');
  assert(Object.values(submission.genome).every(value => typeof value === 'string'), 'Candidate values must be text');
  assert(submission.changes && typeof submission.changes === 'object' && !Array.isArray(submission.changes), 'Missing guarded changes');
  for (const [key, value] of Object.entries(submission.changes)) {
    const change = value as { before?: unknown; after?: unknown };
    assert(change && typeof change.before === 'string' && typeof change.after === 'string'
      && change.before !== change.after && submission.genome[key] === change.after, 'Change does not match candidate text');
  }
  const accounting = submission.accounting;
  assert(accounting?.currency === 'USD' && Number.isSafeInteger(accounting.limitMicros) && accounting.limitMicros > 0
    && Number.isSafeInteger(accounting.occupiedMicros) && accounting.occupiedMicros >= 0
    && accounting.occupiedMicros <= accounting.limitMicros && Array.isArray(accounting.entries), 'Invalid run accounting');
  let charged = 0;
  const invocations = new Map<string, { tokens: number; episode: boolean }>();
  for (const entry of accounting.entries) {
    assert(typeof entry.id === 'string' && entry.id.length > 0 && !invocations.has(entry.id)
      && typeof entry.episode === 'boolean' && Number.isSafeInteger(entry.tokens) && entry.tokens >= 0
      && entry.status === 'settled' && Number.isSafeInteger(entry.chargedMicros) && entry.chargedMicros >= 0, 'Unsettled or invalid charge');
    invocations.set(entry.id, entry);
    charged += entry.chargedMicros;
    assert(Number.isSafeInteger(charged), 'Unsafe charge total');
  }
  assert(charged === accounting.occupiedMicros, 'Charge total differs from accounting');
  const evidence = submission.evidence;
  assert(evidence && Array.isArray(evidence.pairs) && evidence.pairs.length > 0, 'Paired held-out evidence is required');
  assert(typeof evidence.baselineSelected === 'boolean' && evidence.baselineSelected === (Object.keys(submission.changes).length === 0), 'Identity evidence differs from the patch');
  let baselineTokens = 0;
  let candidateTokens = 0;
  let baselineSuccesses = 0;
  let candidateSuccesses = 0;
  let regressions = 0;
  const cases = new Set<string>();
  for (const pair of evidence.pairs) {
    assert(typeof pair.trialId === 'string' && !cases.has(pair.trialId), 'Duplicate or missing held-out trial');
    cases.add(pair.trialId);
    assert(Number.isSafeInteger(pair.baselineTokens) && pair.baselineTokens >= 0
      && Number.isSafeInteger(pair.candidateTokens) && pair.candidateTokens >= 0, 'Invalid paired token totals');
    assert(typeof pair.baselineSuccess === 'boolean' && typeof pair.candidateSuccess === 'boolean', 'Invalid paired outcomes');
    assert(pair.tokenDelta === pair.candidateTokens - pair.baselineTokens, 'Per-trial token delta differs');
    const baselineInvocation = invocations.get(pair.baselineEvaluationId);
    const candidateInvocation = invocations.get(pair.candidateEvaluationId);
    assert(baselineInvocation?.episode === true && candidateInvocation?.episode === true
      && baselineInvocation.tokens === pair.baselineTokens && candidateInvocation.tokens === pair.candidateTokens,
    'Paired trials differ from invocation accounting');
    assert((pair.baselineEvaluationId === pair.candidateEvaluationId) === evidence.baselineSelected, 'Paired invocation identity differs');
    baselineTokens += pair.baselineTokens;
    candidateTokens += pair.candidateTokens;
    baselineSuccesses += Number(pair.baselineSuccess);
    candidateSuccesses += Number(pair.candidateSuccess);
    regressions += Number(pair.baselineSuccess && !pair.candidateSuccess);
  }
  assert(Number.isSafeInteger(baselineTokens) && Number.isSafeInteger(candidateTokens), 'Unsafe token totals');
  assert(evidence.baselineTokens === baselineTokens && evidence.candidateTokens === candidateTokens
    && evidence.baselineSuccesses === baselineSuccesses && evidence.candidateSuccesses === candidateSuccesses, 'Evidence totals differ from paired trials');
  const eligibleForPromotion = evidence.synthetic === false && evidence.baselineSelected !== true && baselineSuccesses > 0
    && candidateSuccesses >= baselineSuccesses && regressions === 0 && candidateTokens < baselineTokens;
  return { valid: true, lane: submission.lane, trials: cases.size, baselineTokens, candidateTokens,
    baselineSuccesses, candidateSuccesses, regressions, eligibleForPromotion };
}
