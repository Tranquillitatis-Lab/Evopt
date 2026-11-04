import path from 'node:path';
import { mkdir, open, readFile, realpath, truncate, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assert, hash, load, save, random } from './common.ts';
import { baseline, breed, candidateId, select, validateGenome } from './genome.ts';
import { invokeTarget, scoreTarget, propose } from './runner.ts';
import { priceUsage, budgetMicros, validateAccounting } from './budget.ts';
import { trainingFeedback, comparison } from './evidence.ts';
import { pairedSchedule, pairedStatistics, trialName } from './protocol.ts';
import type { Config } from './config.ts';
import type { Accounting, Lane, RunContext } from './types.ts';
type LaneState = {
    generation: number;
    candidates: Record<string, Record<string, string>>;
    evaluations: Record<string, any>;
    outputs: Record<string, any>;
    proposals: Record<string, any>;
    history: any[];
    winner?: string;
    finalStarted?: boolean;
    finalSchedule?: any[];
    final?: any;
};
type State = {
    version: 1;
    fingerprint: string;
    sequence: number;
    closed: boolean;
    activeLane?: string;
    lanes: Record<string, LaneState>;
    budget: {
        currency: 'USD';
        limitMicros: number;
        occupiedMicros: number;
        tokens: number;
        entries: any[];
        pending?: any;
        receiptIds: string[];
    };
};
async function withState<T>(config: Config, lane: Lane, fn: (state: LaneState, all: State, persist: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(config.output, { recursive: true });
    const lockPath = path.join(config.output, 'run.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx', 0o600);
    }
    catch {
        throw new Error(`Run locked: ${lockPath}`);
    }
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        await lock.sync();
        const journalPath = path.join(config.output, 'campaign.jsonl');
        let journal = '';
        try {
            journal = await readFile(journalPath, 'utf8');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        const lines = journal.slice(0, journal.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
        const complete = journal.slice(0, journal.lastIndexOf('\n') + 1);
        if (journal.length !== complete.length)
            await truncate(journalPath, Buffer.byteLength(complete));
        let all: State = { version: 1, fingerprint: config.fingerprint, sequence: 0, closed: false, lanes: {}, budget: { currency: 'USD', limitMicros: budgetMicros(config.budget.maxUSD), occupiedMicros: 0, tokens: 0, entries: [], receiptIds: [] } };
        for (const line of lines) {
            const item = JSON.parse(line) as State;
            assert(item.sequence === all.sequence + 1, 'Invalid run journal sequence');
            all = item;
        }
        assert(all.fingerprint === config.fingerprint, 'Configuration changed: use a new output directory');
        assert(!all.budget.pending, 'Interrupted/unknown call: reservation retained; automatic resume refused');
        assert(!all.budget.entries.some(entry => entry.status === 'envelope_violation'), 'Envelope violation blocks automatic resume');
        const state = all.lanes[lane.id] ??= { generation: 0, candidates: {}, evaluations: {}, outputs: {}, proposals: {}, history: [] };
        const persist = async () => {
            all.sequence++;
            const handle = await open(journalPath, 'a', 0o600);
            try {
                await handle.writeFile(JSON.stringify(all) + '\n');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await save(path.join(config.output, 'budget.json'), { fingerprint: all.fingerprint, budget: all.budget });
            await save(path.join(config.output, lane.id, 'state.json'), { ...state, fingerprint: all.fingerprint, budget: all.budget });
        };
        return await fn(state, all, persist);
    }
    finally {
        await lock.close();
        await unlink(lockPath);
    }
}
function protectedBudget(config: Config, all: State, exclude?: {
    lane: string;
    key: string;
}): {
    micros: number;
    tokens: number;
} {
    let count = 0;
    for (const lane of config.lanes) {
        const state = all.lanes[lane.id], baseId = candidateId(lane, baseline(lane));
        for (const task of config.tasks.filter(t => t.split !== 'test'))
            for (let rep = 0; rep < config.evaluation.repetitions; rep++) {
                const key = `${baseId}/${task.split}/${trialName(task, rep, config.evaluation.repetitions)}`;
                if (!(state?.evaluations[key] || state?.outputs[key]) && !(exclude?.lane === lane.id && exclude.key === key))
                    count++;
            }
        // A current baseline winner can still be replaced until search is sealed.
        const arms = all.closed && state?.winner === baseId ? [baseId] : [baseId, state?.winner && state.winner !== baseId ? state.winner : '<winner>'];
        for (const id of arms)
            for (const task of config.tasks.filter(t => t.split === 'test'))
                for (let rep = 0; rep < config.evaluation.repetitions; rep++) {
                    const key = `${id}/test/${trialName(task, rep, config.evaluation.repetitions)}`;
                    if (!(state?.evaluations[key] || state?.outputs[key]) && !(exclude?.lane === lane.id && exclude.key === key))
                        count++;
                }
    }
    const bound = validateAccounting(config.agent.accounting);
    return { micros: count * bound.micros, tokens: count * bound.tokens };
}
class Budget {
    config: Config;
    all: State;
    persist: () => Promise<void>;
    constructor(config: Config, all: State, persist: () => Promise<void>) { this.config = config; this.all = all; this.persist = persist; }
    canFit(accounting: Accounting, extra = { micros: 0, tokens: 0 }, exclude?: {
        lane: string;
        key: string;
    }): boolean {
        const bound = validateAccounting(accounting), reserved = protectedBudget(this.config, this.all, exclude), b = this.all.budget;
        return b.occupiedMicros + bound.micros + extra.micros + reserved.micros <= b.limitMicros && (this.config.budget.maxTokens === undefined || b.tokens + bound.tokens + extra.tokens + reserved.tokens <= this.config.budget.maxTokens);
    }
    async reserve(accounting: Accounting, episode: boolean, exclude?: {
        lane: string;
        key: string;
    }): Promise<RunContext> {
        assert(this.canFit(accounting, { micros: 0, tokens: 0 }, exclude), 'Budget exhausted');
        const bound = validateAccounting(accounting), id = randomUUID(), b = this.all.budget;
        b.occupiedMicros += bound.micros;
        b.tokens += bound.tokens;
        b.pending = { id, reservedMicros: bound.micros, reservedTokens: bound.tokens, episode };
        b.entries.push({ id, status: 'pending', reservedMicros: bound.micros, reservedTokens: bound.tokens, episode });
        await this.persist();
        const timeout = accounting.kind === 'paid' ? accounting.limits.timeoutMs : accounting.timeoutMs;
        return { evaluationId: id, signal: this.config.signal ? AbortSignal.any([this.config.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), ...(accounting.kind === 'paid' ? { limits: structuredClone(accounting.limits) } : {}) };
    }
    async settle(usage: any, accounting: Accounting, saveOutput: () => void): Promise<void> {
        const b = this.all.budget, pending = b.pending;
        assert(pending, 'No pending reservation');
        const priced = priceUsage(usage, accounting, new Set(b.receiptIds));
        const entry = b.entries.find((row: any) => row.id === pending.id);
        entry.receipts = structuredClone(usage.receipts);
        entry.chargedMicros = priced.micros;
        entry.tokens = priced.tokens;
        b.occupiedMicros += priced.micros - pending.reservedMicros;
        b.tokens += priced.tokens - pending.reservedTokens;
        b.receiptIds.push(...priced.ids);
        entry.status = priced.violation ? 'envelope_violation' : 'settled';
        delete b.pending;
        saveOutput();
        await this.persist();
        assert(!priced.violation, 'Adapter exceeded invocation envelope');
    }
}
async function dispatch<T>(context: RunContext, callback: () => Promise<T>): Promise<T> {
    context.signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(context.signal.reason);
        context.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve().then(callback), cancelled]);
    } finally {
        context.signal.removeEventListener('abort', onAbort);
    }
}
async function score(config: Config, lane: Lane, genome: Record<string, string>, split: 'train' | 'gate' | 'test', ctx: {
    state: LaneState;
    all: State;
    persist: () => Promise<void>;
    budget: Budget;
}, only?: {
    task: string;
    repetition: number;
}) {
    const { state, all, persist, budget } = ctx, id = candidateId(lane, genome);
    state.candidates[id] = genome;
    const results: any[] = [];
    for (const task of config.tasks.filter(t => t.split === split))
        for (let repetition = 0; repetition < config.evaluation.repetitions; repetition++) {
            if (only && (task.id !== only.task || repetition !== only.repetition))
                continue;
            const trial = trialName(task, repetition, config.evaluation.repetitions), key = `${id}/${split}/${trial}`;
            if (!state.evaluations[key]) {
                if (!state.outputs[key]) {
                    const context = await budget.reserve(config.agent.accounting, true, { lane: lane.id, key });
                    const result = await dispatch(context, () => invokeTarget(config, lane, genome, task, path.join(config.output, lane.id, 'episodes', id, split, trial), context));
                    await budget.settle(result.usage, config.agent.accounting, () => { state.outputs[key] = result; });
                }
                const result = { ...await scoreTarget(config, task, state.outputs[key]), task: trial, taskId: task.id, repetition,
                    executionIndex: Object.values(all.lanes).reduce((sum, ls) => sum + Object.keys(ls.evaluations).length, 0),
                    evaluationId: state.outputs[key].invocationId, logicalEvaluationId: key };
                state.evaluations[key] = result;
                await persist();
            }
            const result = state.evaluations[key];
            assert(result.selectionEligible !== false, 'Evaluation incomplete');
            results.push(result);
        }
    return { id, genome, results, successes: results.filter(r => r.success).length, tokens: results.reduce((sum, r) => sum + r.tokens, 0) };
}
export async function runSearch(config: Config, lane: Lane) {
    return withState(config, lane, async (state, all, persist) => {
        assert(!all.closed && !state.finalStarted, 'Final holdout was already opened');
        assert(!all.activeLane || all.activeLane === lane.id, 'Resume the interrupted active lane before switching lanes');
        all.activeLane = lane.id;
        await persist();
        const budget = new Budget(config, all, persist), ctx = { state, all, persist, budget }, initial = baseline(lane);
        const reference = await score(config, lane, initial, 'train', ctx), gateReference = await score(config, lane, initial, 'gate', ctx);
        for (let generation = state.generation; generation < config.search.generations; generation++) {
            const rng = random(config.seed + generation), previous = state.history.at(-1)?.elites ?? [reference.id], parents = previous.map((id: string) => state.candidates[id]);
            const plan = [initial, ...parents, ...(lane.seeds ?? [])].filter((g, i, a) => a.findIndex(x => hash(x) === hash(g)) === i).slice(0, config.search.population);
            let attempts = 0;
            while (plan.length < config.search.population && attempts++ < config.search.population * 6 && attempts <= (config.agent.optimization.maxAttempts ?? 10)) {
                let genome = breed(lane, parents[Math.floor(rng() * parents.length)], parents[Math.floor(rng() * parents.length)], rng);
                if (config.search.llmMutation) {
                    const proposer = config.agent.optimization.proposer, target = validateAccounting(config.agent.accounting);
                    const count = config.tasks.filter(t => t.split === 'train').length * config.evaluation.repetitions + config.tasks.filter(t => t.split === 'gate').length * config.evaluation.repetitions * config.search.elites;
                    if (!budget.canFit(proposer.accounting, { micros: target.micros * count, tokens: target.tokens * count }))
                        break;
                    const key = `${generation}/${attempts}`;
                    if (!state.proposals[key]) {
                        if (Object.keys(state.proposals).length >= (config.agent.optimization.maxAttempts ?? 10))
                            break;
                        const context = await budget.reserve(proposer.accounting, false) as RunContext & {
                            attempt?: number;
                        };
                        context.attempt = Object.keys(state.proposals).length + 1;
                        const parentId = candidateId(lane, parents[0]);
                        const examples = config.tasks.filter(task => task.split === 'train').flatMap(task => Array.from({ length: config.evaluation.repetitions }, (_, repetition) => {
                            const trial = trialName(task, repetition, config.evaluation.repetitions);
                            const row = state.evaluations[`${parentId}/train/${trial}`];
                            return row ? { caseId: trial, input: structuredClone(task.input), expected: structuredClone(task.expected), output: structuredClone(row.output), passed: row.success } : null;
                        })).filter(Boolean);
                        const feedback = { examples, experience: trainingFeedback(state, reference.id, 12) };
                        const reply = await dispatch(context, () => propose(config, lane, parents, feedback, path.join(config.output, lane.id, 'proposals', key), context));
                        await budget.settle(reply.usage, proposer.accounting, () => { state.proposals[key] = reply; });
                    }
                    try {
                        const patch = JSON.parse(state.proposals[key].text);
                        assert(patch && typeof patch === 'object' && Object.keys(patch).every(k => Object.hasOwn(lane.genes, k)), 'Proposal changes immutable component');
                        genome = validateGenome(lane, { ...parents[0], ...patch });
                    }
                    catch {
                        continue;
                    }
                }
                if (!plan.some(g => hash(g) === hash(genome)))
                    plan.push(genome);
            }
            const training = [];
            for (const genome of plan) {
                const id = candidateId(lane, genome);
                const missing = config.tasks.filter(task => task.split === 'train').reduce((total, task) => total + Array.from({ length: config.evaluation.repetitions }, (_, rep) => `${id}/train/${trialName(task, rep, config.evaluation.repetitions)}`).filter(key => !state.evaluations[key] && !state.outputs[key]).length, 0);
                if (missing > 0 && id !== reference.id) {
                    const target = validateAccounting(config.agent.accounting);
                    const gate = config.tasks.filter(task => task.split === 'gate').length * config.evaluation.repetitions * config.search.elites;
                    if (!budget.canFit({ kind: 'free', timeoutMs: 1000 }, { micros: target.micros * (missing + gate), tokens: target.tokens * (missing + gate) }))
                        break;
                }
                training.push(await score(config, lane, genome, 'train', ctx));
            }
            const shortlisted = select(training, reference, 0, config.objective).slice(0, config.search.elites), gated = [];
            for (const row of shortlisted)
                gated.push(await score(config, lane, row.genome, 'gate', ctx));
            const qualified = select(gated, gateReference, 0, config.objective), elites = qualified.length ? qualified.map((r: any) => r.id) : [reference.id];
            state.history.push({ generation, parents: previous, elites, training: training.map(({ id, tokens, successes }) => ({ id, tokens, successes })), gate: gated.map(({ id, tokens, successes }) => ({ id, tokens, successes })) });
            state.winner = elites[0];
            state.generation = generation + 1;
            await persist();
        }
        state.winner ??= reference.id;
        delete all.activeLane;
        await persist();
        return { lane: lane.id, winner: state.winner, generations: state.generation, budget: all.budget, status: 'selected-on-validation' };
    });
}
export async function validateFinal(config: Config, lane: Lane) {
    return withState(config, lane, async (state, all, persist) => {
        assert(!all.activeLane && config.lanes.every(l => all.lanes[l.id]?.winner), 'All lanes must finish search before final validation');
        assert(state.winner, 'Search must finish before final validation');
        if (state.final)
            return state.final;
        all.closed = true;
        state.finalStarted = true;
        const baseGenome = baseline(lane), baseId = candidateId(lane, baseGenome);
        state.finalSchedule ??= pairedSchedule(config, lane, baseId, state.winner);
        await persist();
        const budget = new Budget(config, all, persist), ctx = { state, all, persist, budget };
        for (const pair of state.finalSchedule)
            for (const arm of pair.order)
                await score(config, lane, arm === 'baseline' ? baseGenome : state.candidates[state.winner!], 'test', ctx, pair);
        const reference = await score(config, lane, baseGenome, 'test', ctx), candidate = await score(config, lane, state.candidates[state.winner], 'test', ctx);
        const paired = comparison(reference, candidate);
        const regressions = candidate.results.filter((r: any, i: number) => reference.results[i].success && !r.success).map((r: any) => r.task);
        state.final = { ...paired, comparisonKind: baseId === state.winner ? 'identity-control' : 'repeated-task-paired', protocol: { ...config.evaluation, schedule: state.finalSchedule }, statistics: pairedStatistics(paired.pairs, config.seed), status: regressions.length ? 'rejected' : 'no-observed-regression', regressions, baselineTokens: reference.tokens, candidateTokens: candidate.tokens, savings: reference.tokens ? 1 - candidate.tokens / reference.tokens : null, baselineSuccesses: reference.successes, candidateSuccesses: candidate.successes, synthetic: config.agent.accounting.kind === 'free' };
        await persist();
        return state.final;
    });
}
export async function exportWinner(config: Config, lane: Lane, destination: string) {
    return withState(config, lane, async (state, all) => {
        assert(state.final, 'Completed validation required');
        const genome = state.candidates[state.winner!], initial = baseline(lane);
        const changes = Object.fromEntries(Object.keys(genome).filter(key => genome[key] !== initial[key]).map(key => [key, { before: initial[key], after: genome[key] }]));
        const payload = { version: 1, lane: lane.id, fingerprint: config.fingerprint, agent: { id: config.agent.id, version: config.agent.version }, genome, changes, evidence: state.final,
            provenance: { dataset: { id: config.dataset.id, version: config.dataset.version }, proposer: { id: config.agent.optimization.proposer.id, version: config.agent.optimization.proposer.version },
                lane: { id: lane.id, scope: lane.scope }, objective: config.objective, search: config.search, evaluation: config.evaluation, seed: config.seed,
                generations: state.history, reproduce: 'evopt run --config <your-config.json>; evopt validate --config <your-config.json>' },
            accounting: { currency: 'USD', limitMicros: all.budget.limitMicros, occupiedMicros: all.budget.occupiedMicros, tokens: all.budget.tokens, entries: all.budget.entries } };
        const root = await realpath(config.output);
        const parent = await realpath(path.dirname(path.resolve(destination)));
        const target = path.join(parent, path.basename(destination));
        const relative = path.relative(root, target);
        assert(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'Export must be outside the run directory');
        const result = { ...payload, digest: hash(payload) };
        await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        return { destination: target, result };
    });
}
export async function readState(config: Config): Promise<any> { return load(path.join(config.output, 'budget.json')); }
