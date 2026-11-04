import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, integer, load, hash } from './common.ts';
import { validateAccounting, budgetMicros } from './budget.ts';
import { baseline, validateGenome, validateLane } from './genome.ts';
import type { Agent, Dataset, Lane } from './types.ts';
export interface ConfigOptions {
    agent: Agent<any, any>;
    dataset: Dataset<any, any>;
    lanes: Lane[];
    search?: {
        population: number;
        generations: number;
        elites: number;
        llmMutation: boolean;
    };
    evaluation?: {
        repetitions: number;
        order?: 'balanced';
    };
    budget: number | {
        maxUSD: number;
        maxTokens?: number;
    };
    maxTokens?: number;
    output?: string;
    directory?: string;
    objective?: 'tokens' | 'accuracy';
    seed?: number;
    signal?: AbortSignal;
}
export interface Config extends Omit<ConfigOptions, 'budget' | 'output' | 'directory' | 'search' | 'evaluation' | 'objective'> {
    tasks: {
        id: string;
        split: 'train' | 'gate' | 'test';
        input: unknown;
        expected: unknown;
    }[];
    search: {
        population: number;
        generations: number;
        elites: number;
        llmMutation: boolean;
    };
    evaluation: {
        repetitions: number;
        order: 'balanced';
    };
    budget: {
        currency: 'USD';
        maxUSD: number;
        maxTokens?: number;
    };
    output: string;
    objective: 'tokens' | 'accuracy';
    seed: number;
    fingerprint: string;
}
export function buildConfig(options: ConfigOptions): Config {
    const { agent, dataset } = options;
    assert(agent && typeof agent.id === 'string' && !!agent.id && typeof agent.version === 'string' && !!agent.version, 'Agent id and version required');
    assert(agent.components && agent.mutable && typeof agent.run === 'function', 'Configured agent components, mutable allowlist and run callback required');
    const proposer = agent.optimization?.proposer;
    assert(proposer && !!proposer.id && !!proposer.version && typeof proposer.propose === 'function', 'Explicit proposer required');
    if (agent.optimization.maxAttempts !== undefined)
        integer(agent.optimization.maxAttempts, 0, 10000, 'maxAttempts');
    validateAccounting(agent.accounting);
    validateAccounting(proposer.accounting);
    for (const [key, rule] of Object.entries(agent.mutable)) {
        assert(Object.hasOwn(agent.components, key) && typeof agent.components[key] === 'string', 'Mutable component missing');
        assert(!!rule.role?.trim(), 'Mutable component role required');
        integer(rule.maxLength, 1, 1000000, 'maxLength');
        assert(agent.components[key].length <= rule.maxLength, 'Initial component exceeds maximum length');
    }
    assert(Object.keys(agent.mutable).length > 0, 'Mutable allowlist required');
    assert(dataset && !!dataset.id && !!dataset.version && typeof dataset.score === 'function', 'Labeled dataset and scorer required');
    const tasks: Config['tasks'] = [], ids = new Set<string>(), inputs = new Map<string, string>();
    for (const [source, split] of [['train', 'train'], ['validation', 'gate'], ['test', 'test']] as const) {
        assert(Array.isArray(dataset[source]) && dataset[source].length > 0, 'All dataset partitions must be nonempty');
        for (const item of dataset[source]) {
            assert(item && typeof item.id === 'string' && !!item.id && Object.hasOwn(item, 'input') && Object.hasOwn(item, 'expected'), 'Malformed dataset case');
            assert(!ids.has(item.id), 'Duplicate dataset case id');
            ids.add(item.id);
            const encoded = JSON.stringify(item.input);
            assert(encoded !== undefined && JSON.stringify(item.expected) !== undefined, 'Dataset values must be JSON');
            assert(!inputs.has(encoded) || inputs.get(encoded) === split, 'Input duplicated across partitions');
            inputs.set(encoded, split);
            tasks.push({ id: item.id, split, input: structuredClone(item.input), expected: structuredClone(item.expected) });
        }
    }
    const objective = options.objective ?? 'tokens';
    assert(['tokens', 'accuracy'].includes(objective), 'Unsupported objective');
    const amount = typeof options.budget === 'number' ? options.budget : options.budget?.maxUSD;
    budgetMicros(amount);
    const maxTokens = options.maxTokens ?? (typeof options.budget === 'object' ? options.budget.maxTokens : undefined);
    if (maxTokens !== undefined)
        integer(maxTokens, 1, Number.MAX_SAFE_INTEGER, 'maxTokens');
    const search = { population: 1, generations: 1, elites: 1, llmMutation: true, ...options.search };
    integer(search.population, 1, 100, 'population');
    integer(search.generations, 1, 10000, 'generations');
    integer(search.elites, 1, search.population, 'elites');
    assert(typeof search.llmMutation === 'boolean', 'llmMutation must be boolean');
    const evaluation = { repetitions: 1, order: 'balanced' as const, ...options.evaluation };
    integer(evaluation.repetitions, 1, 30, 'repetitions');
    assert(evaluation.order === 'balanced', 'Only balanced order supported');
    const lanes = structuredClone(options.lanes);
    assert(Array.isArray(lanes) && lanes.length > 0, 'At least one lane required');
    assert(new Set(lanes.map(l => l.id)).size === lanes.length, 'Duplicate lanes');
    for (const lane of lanes) {
        validateLane(lane);
        validateGenome(lane, baseline(lane));
        for (const seed of lane.seeds ?? []) validateGenome(lane, seed);
        for (const [key, gene] of Object.entries(lane.genes)) {
            assert(Object.hasOwn(agent.mutable, key) && agent.components[key] === gene.initial, `Lane gene ${key} requires matching mutable component`);
            const length = gene.type === 'text' ? gene.maxChars : Math.max(...gene.values.map(value => value.length));
            assert(length <= agent.mutable[key].maxLength, `Lane gene ${key} exceeds component maximum`);
        }
    }
    const configuredAgent = {
        ...agent,
        ...('structure' in agent ? { structure: structuredClone(agent.structure) } : {}),
        components: structuredClone(agent.components),
        mutable: structuredClone(agent.mutable),
        accounting: structuredClone(agent.accounting),
        optimization: {
            ...agent.optimization,
            proposer: { ...proposer, accounting: structuredClone(proposer.accounting) },
        },
    };
    const configuredDataset = {
        ...dataset,
        train: structuredClone(dataset.train),
        validation: structuredClone(dataset.validation),
        test: structuredClone(dataset.test),
    };
    const config: Config = {
        agent: configuredAgent, dataset: configuredDataset, tasks, lanes, search, evaluation,
        objective, seed: options.seed ?? 0,
        budget: { currency: 'USD', maxUSD: amount, ...(maxTokens === undefined ? {} : { maxTokens }) },
        output: path.resolve(options.output ?? options.directory ?? '.evopt/run'),
        signal: options.signal, fingerprint: '',
    };
    integer(config.seed, 0, 0xffffffff, 'seed');
    config.fingerprint = hash({
        engine: 'evopt-reference-1',
        agent: { id: agent.id, version: agent.version, components: agent.components, mutable: agent.mutable,
            accounting: agent.accounting, maxAttempts: agent.optimization.maxAttempts ?? 10,
            structure: 'structure' in agent ? agent.structure : undefined },
        proposer: { id: proposer.id, version: proposer.version, accounting: proposer.accounting },
        dataset: { id: dataset.id, version: dataset.version, tasks },
        lanes, search, evaluation, objective, seed: config.seed, budget: config.budget,
    });
    return config;
}
export async function readConfig(file: string): Promise<Config> {
    const raw = await load(file);
    const root = path.dirname(path.resolve(file));
    assert(raw.version === 1, 'Expected config version 1');
    const agentModule = await import(pathToFileURL(path.resolve(root, raw.agentModule)).href);
    const datasetModule = raw.datasetModule === raw.agentModule ? agentModule
        : await import(pathToFileURL(path.resolve(root, raw.datasetModule)).href);
    const lanes = await Promise.all(raw.lanes.map((entry: unknown) =>
        typeof entry === 'string' ? load(path.resolve(root, entry)) : entry));
    return buildConfig({ ...raw, agent: agentModule.agent, dataset: datasetModule.dataset,
        lanes, output: path.resolve(root, raw.output) });
}
