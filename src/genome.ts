import { assert, hash, integer, stable } from './common.ts';
import type { Lane } from './types.ts';
export function validateLane(lane: Lane): void {
    assert(/^[a-z][a-z0-9-]{0,63}$/.test(lane.id), 'Invalid lane id');
    assert(lane.genes && Object.keys(lane.genes).length > 0, 'Lane needs genes');
    for (const [name, gene] of Object.entries(lane.genes)) {
        assert(/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name), 'Invalid gene name');
        if (gene.type === 'choice')
            assert(Array.isArray(gene.values) && gene.values.length > 0 && gene.values.every(value => typeof value === 'string') && gene.values.includes(gene.initial), 'Invalid choices');
        else {
            assert(gene.type === 'text', 'Unsupported gene type');
            integer(gene.maxChars, 1, 32000, 'maxChars');
            assert(typeof gene.initial === 'string' && gene.initial.length <= gene.maxChars, 'Invalid initial text');
        }
    }
}
export const baseline = (lane: Lane): Record<string, string> => Object.fromEntries(Object.entries(lane.genes).map(([key, gene]) => [key, gene.initial]));
export function validateGenome(lane: Lane, genome: Record<string, string>): Record<string, string> {
    assert(genome && typeof genome === 'object' && !Array.isArray(genome), 'Genome must be an object');
    assert(stable(Object.keys(genome).sort()) === stable(Object.keys(lane.genes).sort()), 'Genome keys differ from lane');
    for (const [key, gene] of Object.entries(lane.genes)) {
        const value = genome[key];
        assert(typeof value === 'string', `Invalid gene ${key}`);
        if (gene.type === 'choice')
            assert(gene.values.includes(value), `Unknown choice ${key}`);
        else
            assert(value.length <= gene.maxChars, `Text exceeds maxChars: ${key}`);
        for (const text of gene.required ?? [])
            assert(value.includes(text), `Missing protected text in ${key}`);
    }
    return genome;
}
export const candidateId = (lane: Lane, genome: Record<string, string>): string => hash({ lane: lane.id, genome }).slice(0, 20);
export function breed(lane: Lane, a: Record<string, string>, b: Record<string, string>, rng: () => number): Record<string, string> {
    const child: Record<string, string> = {};
    for (const [key, gene] of Object.entries(lane.genes)) {
        child[key] = rng() < 0.5 ? a[key] : b[key];
        if (gene.type === 'choice' && rng() < 0.5)
            child[key] = gene.values[Math.floor(rng() * gene.values.length)];
    }
    return validateGenome(lane, child);
}
export function render(lane: Lane, genome: Record<string, string>): string { validateGenome(lane, genome); return [lane.protectedPolicy, ...Object.entries(genome).map(([key, value]) => `${key}:\n${value}`)].filter(Boolean).join('\n\n'); }
export function select(records: any[], reference: any, maxRegressions = 0, objective = 'tokens'): any[] {
    return records.filter(r => r.results.length === reference.results.length && r.results.every((x: any) => x.safety === true && x.selectionEligible !== false) && r.successes >= reference.successes && r.results.filter((x: any, i: number) => reference.results[i].success && !x.success).length <= maxRegressions)
        .sort((a, b) => (objective === 'accuracy' ? b.successes - a.successes : a.tokens - b.tokens) || (a.id === reference.id ? -1 : b.id === reference.id ? 1 : a.id.localeCompare(b.id)));
}
