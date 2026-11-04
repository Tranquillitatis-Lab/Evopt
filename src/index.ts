import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateAccounting } from './budget.ts';
import { assert, hash, integer } from './common.ts';
import { buildConfig } from './config.ts';
import { runSearch, validateFinal } from './search.ts';
import type { Agent, Lane, OptimizationResult, OptimizeOptions, Proposer } from './types.ts';

export type * from './types.ts';

/** Declare an existing agent and its explicit, metered optimization boundary. */
export function defineAgent<I, O>(agent: Agent<I, O>): Agent<I, O> {
  assert(agent && typeof agent.id === 'string' && agent.id.trim() && typeof agent.version === 'string' && agent.version.trim(), 'Agent id and version required');
  assert(agent.components && agent.mutable && typeof agent.run === 'function', 'Agent components, mutable allowlist and run callback required');
  assert(Object.keys(agent.mutable).length > 0, 'Mutable allowlist required');
  for (const [key, rule] of Object.entries(agent.mutable)) {
    assert(Object.hasOwn(agent.components, key) && typeof agent.components[key] === 'string', `Mutable component missing: ${key}`);
    assert(rule && typeof rule.role === 'string' && rule.role.trim(), `Component role required: ${key}`);
    integer(rule.maxLength, 1, 32000, 'maxLength');
    assert(agent.components[key].length <= rule.maxLength, `Initial component exceeds maximum length: ${key}`);
  }
  validateAccounting(agent.accounting);
  if (agent.structure !== undefined) {
    const { nodes = [], tools = [], handoffs = [] } = agent.structure;
    assert(Array.isArray(nodes) && Array.isArray(tools) && Array.isArray(handoffs), 'Invalid agent structure');
    const nodeIds = new Set<string>();
    for (const node of nodes) {
      assert(node && typeof node.id === 'string' && node.id.trim() && typeof node.role === 'string' && node.role.trim()
        && !nodeIds.has(node.id), 'Each node needs a unique id and role');
      assert(node.components === undefined || (Array.isArray(node.components) && node.components.every((key: unknown) => typeof key === 'string' && Object.hasOwn(agent.components, key))), 'Node references an unknown component');
      nodeIds.add(node.id);
    }
    const toolIds = new Set<string>();
    for (const tool of tools) {
      assert(tool && typeof tool.id === 'string' && tool.id.trim() && typeof tool.contract === 'string' && tool.contract.trim()
        && !toolIds.has(tool.id), 'Each tool needs a unique id and immutable contract');
      assert(tool.descriptionComponent === undefined || Object.hasOwn(agent.components, tool.descriptionComponent), 'Tool references an unknown component');
      toolIds.add(tool.id);
    }
    for (const handoff of handoffs) assert(handoff && nodeIds.has(handoff.from) && nodeIds.has(handoff.to)
      && (handoff.description === undefined || typeof handoff.description === 'string'), 'Handoff references an unknown node');
  }
  const proposer = agent.optimization?.proposer;
  assert(proposer && typeof proposer.id === 'string' && proposer.id.trim() && typeof proposer.version === 'string' && proposer.version.trim() && typeof proposer.propose === 'function', 'Explicit proposer required');
  validateAccounting(proposer.accounting);
  if (agent.optimization.maxAttempts !== undefined) integer(agent.optimization.maxAttempts, 0, 99, 'maxAttempts');
  return { ...agent, components: Object.freeze({ ...agent.components }), mutable: Object.freeze(structuredClone(agent.mutable)),
    ...(agent.structure ? { structure: structuredClone(agent.structure) } : {}), optimization: { ...agent.optimization } };
}

/** A predictable, zero-cost proposer for local development and tests. */
export function createOfflineProposer<I = unknown, O = unknown>(patches: readonly Readonly<Record<string, string>>[]): Proposer<I, O> {
  assert(Array.isArray(patches) && patches.every(patch => patch && typeof patch === 'object' && !Array.isArray(patch) && Object.values(patch).every(value => typeof value === 'string')), 'Offline proposals must be text patches');
  const choices = structuredClone(patches);
  return {
    id: 'offline', version: `1:${hash(choices)}`, accounting: { kind: 'free', timeoutMs: 10_000 },
    async propose(request, context) {
      context.signal.throwIfAborted();
      return { output: { ...(choices[request.attempt - 1] ?? {}) }, usage: { complete: true, receipts: [] } };
    },
  };
}

/** Exact equality for JSON-compatible labels. Applications can supply their own scorer. */
export function exactMatch<I, O>({ output, expected }: { input: I; output: O; expected: O }): boolean {
  return JSON.stringify(output) === JSON.stringify(expected);
}

/** Run a complete train, validation, and held-out test cycle under one USD ceiling. */
export async function optimize<I, O>(options: OptimizeOptions<I, O>): Promise<OptimizationResult<O>> {
  assert(options && typeof options === 'object', 'Optimization options required');
  const agent = defineAgent(options.agent);
  const attempts = agent.optimization.maxAttempts ?? 10;
  const lane: Lane = {
    id: 'agent', scope: 'Developer-declared mutable text components', protectedPolicy: '',
    genes: Object.fromEntries(Object.keys(agent.mutable).map(key => [key, {
      type: 'text' as const, initial: agent.components[key], maxChars: agent.mutable[key].maxLength,
    }])),
  };
  assert(!options.run?.resume || options.run.directory, 'Resuming requires an explicit directory');
  const directory = path.resolve(options.run?.directory ?? path.join('.evopt', 'runs', randomUUID()));
  const config = buildConfig({ agent, dataset: options.dataset, lanes: [lane], budget: options.budget,
    objective: options.objective, output: directory, signal: options.run?.signal, maxTokens: options.run?.maxTokens,
    search: { population: attempts + 1, generations: 1, elites: 1, llmMutation: attempts > 0 } });
  if (!options.run?.resume) {
    try { await readFile(path.join(directory, 'campaign.jsonl')); throw new Error('Run directory already exists; use resume or choose a fresh directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let alreadyValidating = false;
  if (options.run?.resume) {
    try {
      const journal = await readFile(path.join(directory, 'campaign.jsonl'), 'utf8');
      const completeLines = journal.slice(0, journal.lastIndexOf('\n') + 1).trim().split('\n');
      if (completeLines[0]) {
        const snapshot = JSON.parse(completeLines[completeLines.length - 1]);
        alreadyValidating = snapshot.lanes?.[lane.id]?.finalStarted === true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!alreadyValidating) await runSearch(config, lane);
  const final = await validateFinal(config, lane);
  const state = JSON.parse(await readFile(path.join(directory, lane.id, 'state.json'), 'utf8'));
  const selected = final.regressions.length ? agent.components : { ...agent.components, ...state.candidates[state.winner] };
  const changes = Object.fromEntries(Object.keys(agent.mutable).filter(key => selected[key] !== agent.components[key])
    .map(key => [key, { before: agent.components[key], after: selected[key] }]));
  const evaluations = Object.entries(state.evaluations as Record<string, { taskId: string; output: O; success: boolean }>)
    .filter(([key]) => key.startsWith(`${state.winner}/test/`))
    .map(([, row]) => ({ caseId: row.taskId, output: row.output, passed: row.success }));
  const total = final.pairs.length;
  return { status: 'completed', directory, components: selected, changes, evaluations,
    test: { baselineAccuracy: final.baselineSuccesses / total, candidateAccuracy: final.candidateSuccesses / total },
    accounting: { currency: 'USD', limitMicros: state.budget.limitMicros, occupiedMicros: state.budget.occupiedMicros, entries: state.budget.entries } };
}
