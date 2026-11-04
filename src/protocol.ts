import { assert, hash, random } from './common.ts';
import type { Config } from './config.ts';
import type { Lane } from './types.ts';

export const trialName = (task: { id: string }, repetition: number, repetitions: number): string =>
  repetitions === 1 ? task.id : `${task.id}~r${repetition}`;

export function pairedSchedule(config: Config, lane: Lane, baselineId: string, candidateId: string) {
  return config.tasks.filter(task => task.split === 'test').flatMap(task => {
    const first = parseInt(hash({ seed: config.seed, task: task.id }).slice(0, 8), 16) % 2;
    return Array.from({ length: config.evaluation.repetitions }, (_, repetition) => ({
      task: task.id,
      repetition,
      pairId: hash({ fingerprint: config.fingerprint, lane: lane.id, candidateId, task: task.id, repetition }),
      order: baselineId === candidateId ? ['baseline']
        : (first + repetition) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
      independentArms: baselineId !== candidateId,
    }));
  });
}

export function pairedStatistics(pairs: any[], seed = 0) {
  assert(pairs.length > 0, 'No pairs');
  const groups = new Map<string, number[]>();
  for (const pair of pairs) {
    const rows = groups.get(pair.task) ?? [];
    rows.push(pair.tokenDelta);
    groups.set(pair.task, rows);
  }
  const means = [...groups.values()].map(rows => rows.reduce((sum, value) => sum + value, 0) / rows.length);
  const rng = random(seed);
  const draws: number[] = [];
  for (let i = 0; i < 1000; i++) {
    draws.push(means.reduce(sum => sum + means[Math.floor(rng() * means.length)], 0) / means.length);
  }
  draws.sort((a, b) => a - b);
  return {
    method: 'descriptive-task-cluster-bootstrap-v1',
    tasks: means.length,
    pairedObservations: pairs.length,
    meanTaskTokenDelta: means.reduce((sum, value) => sum + value, 0) / means.length,
    tokenDeltaCI95: means.length > 1 ? [draws[25], draws[974]] : null,
    baselineOnlyResolved: pairs.filter(pair => pair.baselineSuccess && !pair.candidateSuccess).length,
    candidateOnlyResolved: pairs.filter(pair => !pair.baselineSuccess && pair.candidateSuccess).length,
    statisticalNonInferiorityProven: false,
    providerSamplingControlled: false,
    cacheControlled: false,
  };
}
