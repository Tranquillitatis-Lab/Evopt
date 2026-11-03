import type { AgentStructure, AgentTextConfiguration, ComponentTarget } from './types.js';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function nonempty(value: unknown, label: string): asserts value is string {
  require(typeof value === 'string' && value.trim().length > 0, `${label} must be nonempty text`);
}
function id(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  require(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value), `${label} must be a stable identifier`);
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  require(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unexpected or missing agent structure field');
}
/** Accept data only: no callbacks, instances, accessors, symbols, holes, or cycles. */
function jsonData(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { require(Number.isFinite(value), 'Structure metadata numbers must be finite'); return; }
  require(typeof value === 'object' && value !== null && !ancestors.has(value), 'Structure metadata must be acyclic JSON data');
  require(Array.isArray(value) || object(value), 'Structure metadata must contain plain JSON objects');
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  require(Reflect.ownKeys(value).every(key => typeof key === 'string'), 'Structure metadata cannot contain symbol properties');
  if (Array.isArray(value)) {
    require(Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index)), 'Structure metadata arrays must be dense');
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    require(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'Structure metadata cannot contain accessors or hidden properties');
    jsonData(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
function uniqueStrings(value: unknown, label: string, identifiers = false): asserts value is string[] {
  require(Array.isArray(value), `${label} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    if (identifiers) id(item, label); else nonempty(item, label);
    require(!seen.has(item), `${label} contains a duplicate`); seen.add(item);
  }
}

/** Validate the portable graph description and its ownership of mutable text keys. */
export function validateStructure(agent: AgentTextConfiguration): void {
  require(object(agent) && object(agent.components) && object(agent.mutable), 'Agent structure needs components and a mutable allowlist');
  require(Object.keys(agent.components).length > 0 && Object.keys(agent.mutable).length > 0, 'Agent text configuration needs nonempty components and a mutable allowlist');
  jsonData(agent.components);
  for (const [key, contents] of Object.entries(agent.components)) {
    nonempty(key, 'Component key');
    require(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe component key');
    require(typeof contents === 'string', 'Components must be text');
  }
  // Specifications are plain data even for flat adapters. Existing role/length-only
  // specifications remain valid; unresolved node/tool bindings do not.
  jsonData(agent.mutable);
  for (const [key, specification] of Object.entries(agent.mutable)) {
    require(object(specification), 'Invalid mutable component specification');
    fields(specification, ['role', 'maxLength'], ['kind', 'target']);
    nonempty(specification.role, 'Mutable component role');
    require(Number.isSafeInteger(specification.maxLength) && specification.maxLength > 0, 'Mutable component maxLength must be a positive safe integer');
    require(Object.hasOwn(agent.components, key) && typeof agent.components[key] === 'string', 'Mutable component missing');
    require(agent.components[key]!.length <= specification.maxLength, 'Initial component exceeds length');
    require(specification.kind === undefined || ['prompt', 'tool-description'].includes(specification.kind), 'Unsupported mutable component kind');
    if (specification.target !== undefined) {
      require(object(specification.target), 'Invalid component target'); fields(specification.target, ['type', 'id']);
      require(specification.target.type === 'node' || specification.target.type === 'tool', 'Unsupported component target type');
      id(specification.target.id, 'Component target id');
    }
  }
  if (agent.structure === undefined) {
    require(Object.values(agent.mutable).every(specification => specification.target === undefined), 'Component targets require agent structure');
    return;
  }
  jsonData(agent.structure);
  const structure = agent.structure;
  require(object(structure), 'Invalid agent structure'); fields(structure, ['version', 'nodes', 'tools', 'handoffs']);
  require(structure.version === 1, 'Unsupported agent structure version');
  require(Array.isArray(structure.nodes) && structure.nodes.length > 0, 'Agent structure needs at least one node');
  require(Array.isArray(structure.tools) && Array.isArray(structure.handoffs), 'Agent structure needs tools and handoffs arrays');
  const nodes = new Set<string>(), tools = new Set<string>(), handoffs = new Set<string>();
  const owners = new Map<string, ComponentTarget>();
  function own(key: unknown, target: ComponentTarget): void {
    nonempty(key, 'Component key');
    require(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe component key');
    require(Object.hasOwn(agent.components, key) && typeof agent.components[key] === 'string', `Structure references missing text component ${key}`);
    require(!owners.has(key), `Component ${key} has multiple structure owners`); owners.set(key, target);
  }
  for (const node of structure.nodes) {
    require(object(node), 'Invalid agent node'); fields(node, ['id', 'role', 'promptKeys', 'toolIds']);
    id(node.id, 'Node id'); nonempty(node.role, 'Node role');
    require(!nodes.has(node.id), 'Duplicate node id'); nodes.add(node.id);
    uniqueStrings(node.promptKeys, 'Node prompt keys'); uniqueStrings(node.toolIds, 'Node tool ids', true);
    for (const key of node.promptKeys) own(key, { type: 'node', id: node.id });
  }
  for (const tool of structure.tools) {
    require(object(tool), 'Invalid agent tool'); fields(tool, ['id', 'descriptionKey', 'constraints'], ['inputSchema', 'outputSchema']);
    id(tool.id, 'Tool id'); require(!tools.has(tool.id), 'Duplicate tool id'); tools.add(tool.id);
    uniqueStrings(tool.constraints, 'Tool constraints');
    for (const schema of [tool.inputSchema, tool.outputSchema]) if (schema !== undefined) {
      require(typeof schema === 'boolean' || object(schema), 'Tool schema must be a JSON object or boolean');
    }
    own(tool.descriptionKey, { type: 'tool', id: tool.id });
  }
  const usedTools = new Set<string>();
  for (const node of structure.nodes) for (const toolId of node.toolIds) {
    require(tools.has(toolId), `Node ${node.id} references unknown tool ${toolId}`); usedTools.add(toolId);
  }
  require([...tools].every(toolId => usedTools.has(toolId)), 'Every declared tool must belong to at least one node');
  for (const handoff of structure.handoffs) {
    require(object(handoff), 'Invalid agent handoff'); fields(handoff, ['id', 'from', 'to', 'description'], ['contract']);
    id(handoff.id, 'Handoff id'); nonempty(handoff.description, 'Handoff description');
    id(handoff.from, 'Handoff source'); id(handoff.to, 'Handoff destination');
    require(!handoffs.has(handoff.id), 'Duplicate handoff id'); handoffs.add(handoff.id);
    require(nodes.has(handoff.from) && nodes.has(handoff.to), 'Handoff references an unknown node');
  }
  for (const [key, specification] of Object.entries(agent.mutable)) {
    const owner = owners.get(key);
    require(owner, `Mutable component ${key} has no structure owner`);
    require(specification.target?.type === owner.type && specification.target.id === owner.id, `Mutable component ${key} target does not match its structure owner`);
    require(specification.kind === (owner.type === 'node' ? 'prompt' : 'tool-description'), `Mutable component ${key} kind does not match its structure owner`);
  }
}

/** Snapshot public roles/contracts/topology without including any component contents. */
export function proposalContext(agent: AgentTextConfiguration): AgentStructure | undefined {
  validateStructure(agent);
  if (agent.structure === undefined) return undefined;
  const snapshot = JSON.parse(JSON.stringify(agent.structure)) as AgentStructure;
  function freeze(value: unknown): void {
    if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  }
  freeze(snapshot); return snapshot;
}
