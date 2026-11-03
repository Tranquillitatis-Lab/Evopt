import type { AgentTextConfiguration, Components, ComponentTarget, OptimizationResult } from './types.js';
import { validateStructure } from './structure.js';
import { applyPatch, assert, canonical, clone, freeze, hash, record, text } from './validation.js';

export interface ConfigurationEdit {
  key: string; role: string; kind?: 'prompt' | 'tool-description'; target?: ComponentTarget;
  before: string; after: string;
}
/** Reviewed text edits bound to an exact baseline and immutable configuration contract. */
export interface ConfigurationPatch {
  format: 1; agentId: string; agentVersion: string;
  baselineSha256: string; mutableSha256: string; structureSha256: string;
  edits: ConfigurationEdit[]; digest: string;
}
type PatchSource = Pick<OptimizationResult<unknown>, 'candidates' | 'components' | 'selectedId' | 'provenance' | 'configuration'>;
const digest = ({ digest: _digest, ...body }: ConfigurationPatch) => hash(body);

export function createConfigurationPatch(source: PatchSource): ConfigurationPatch {
  const baseline = source.candidates[0];
  assert(baseline && source.configuration, 'Patch export requires the original mutable configuration contract');
  text(source.provenance.agentId); text(source.provenance.agentVersion);
  assert(baseline.id === hash(baseline.components), 'Invalid baseline component identity');
  assert(source.selectedId === hash(source.components), 'Invalid selected component identity');
  const selected = source.candidates.find(candidate => candidate.id === source.selectedId);
  assert(selected && canonical(selected.components) === canonical(source.components), 'Patch selection is missing from candidate evidence');
  const configuration = { components: baseline.components, ...source.configuration };
  validateStructure(configuration);
  assert(canonical(Object.keys(source.components).sort()) === canonical(Object.keys(baseline.components).sort()), 'Patch cannot change component keys');
  const edits: ConfigurationEdit[] = [];
  for (const key of Object.keys(baseline.components).sort()) if (baseline.components[key] !== source.components[key]) {
    const spec = configuration.mutable[key];
    assert(spec && typeof source.components[key] === 'string', 'Patch changes an immutable component');
    edits.push({ key, role: spec.role, ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.target ? { target: clone(spec.target) } : {}),
      before: baseline.components[key]!, after: source.components[key]! });
  }
  if (edits.length) applyPatch(baseline.components, configuration.mutable, Object.fromEntries(edits.map(e => [e.key, e.after])));
  const patch: ConfigurationPatch = { format: 1, agentId: source.provenance.agentId, agentVersion: source.provenance.agentVersion,
    baselineSha256: hash(baseline.components), mutableSha256: hash(configuration.mutable), structureSha256: hash(configuration.structure ?? null), edits, digest: '' };
  patch.digest = digest(patch); return clone(patch);
}

export function validateConfigurationPatch(value: unknown): asserts value is ConfigurationPatch {
  assert(record(value) && value.format === 1, 'Unsupported configuration patch');
  const allowed = ['format','agentId','agentVersion','baselineSha256','mutableSha256','structureSha256','edits','digest'];
  assert(Object.keys(value).length === allowed.length && Object.keys(value).every(k => allowed.includes(k)), 'Unexpected configuration patch fields');
  text(value.agentId); text(value.agentVersion);
  for (const key of ['baselineSha256','mutableSha256','structureSha256','digest']) assert(typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]), 'Invalid configuration patch digest');
  assert(Array.isArray(value.edits), 'Missing configuration edits');
  const keys = new Set<string>();
  for (const edit of value.edits) {
    assert(record(edit) && Object.keys(edit).every(k => ['key','role','kind','target','before','after'].includes(k)), 'Malformed configuration edit');
    text(edit.key); text(edit.role);
    assert(!keys.has(edit.key) && !['__proto__','prototype','constructor'].includes(edit.key), 'Duplicate or unsafe patch key'); keys.add(edit.key);
    assert(typeof edit.before === 'string' && typeof edit.after === 'string' && edit.before !== edit.after, 'Patch needs a changed text value');
    assert(edit.kind === undefined || edit.kind === 'prompt' || edit.kind === 'tool-description', 'Invalid edit kind');
    if (edit.target !== undefined) {
      assert(record(edit.target) && Object.keys(edit.target).length === 2 && Object.keys(edit.target).every(k => ['type','id'].includes(k)), 'Invalid edit target');
      text(edit.target.id); assert(edit.target.type === 'node' || edit.target.type === 'tool', 'Invalid edit target type');
    }
  }
  assert(value.digest === digest(value as unknown as ConfigurationPatch), 'Configuration patch digest mismatch');
}

/** Return new text values for explicit adoption; this never invokes or changes a running agent. */
export function applyConfigurationPatch(agent: AgentTextConfiguration & { id: string; version: string }, patch: ConfigurationPatch): Components {
  validateStructure(agent); validateConfigurationPatch(patch);
  assert(agent.id === patch.agentId && agent.version === patch.agentVersion, 'Configuration patch agent/version mismatch');
  assert(hash(agent.components) === patch.baselineSha256, 'Configuration patch baseline mismatch');
  assert(hash(agent.mutable) === patch.mutableSha256 && hash(agent.structure ?? null) === patch.structureSha256, 'Configuration patch contract mismatch');
  const changes: Record<string, string> = {};
  for (const edit of patch.edits) {
    const spec = agent.mutable[edit.key];
    assert(spec && agent.components[edit.key] === edit.before && spec.role === edit.role && spec.kind === edit.kind
      && canonical(spec.target ?? null) === canonical(edit.target ?? null), 'Configuration patch edit differs from its declared target');
    changes[edit.key] = edit.after;
  }
  return patch.edits.length ? applyPatch(agent.components, agent.mutable, changes) : freeze(clone(agent.components));
}
