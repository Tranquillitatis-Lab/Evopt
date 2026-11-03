import type { AgentTextConfiguration, Components, JsonSchema } from './types.js';
import { validateStructure } from './structure.js';
import { assert, clone, record } from './validation.js';

type ObjectSchema = Exclude<JsonSchema, boolean>;
export interface OpenAIChatConfiguration {
  messages: { role: 'system'; content: string }[];
  tools: { type: 'function'; function: { name: string; description: string; parameters: ObjectSchema } }[];
}
export interface AnthropicConfiguration {
  system: string;
  tools: { name: string; description: string; input_schema: ObjectSchema }[];
}

function nodeConfiguration(agent: AgentTextConfiguration, nodeId: string, components: Components | undefined, maxNameLength: number) {
  validateStructure(agent);
  assert(agent.structure !== undefined, 'Configuration mapping requires an explicit agent structure');
  const selected = components === undefined ? agent.components : components;
  // Validate the complete candidate as data before reading its component values.
  validateStructure({ components: selected, mutable: agent.mutable, structure: agent.structure });
  const originalKeys = Object.keys(agent.components), selectedKeys = Object.keys(selected);
  assert(selectedKeys.length === originalKeys.length && originalKeys.every(key => Object.hasOwn(selected, key)), 'Mapped components must contain exactly the declared component keys');
  for (const key of originalKeys) {
    assert(Object.hasOwn(agent.mutable, key) || selected[key] === agent.components[key], `Mapping changes immutable component ${key}`);
  }
  const node = agent.structure.nodes.find(value => value.id === nodeId);
  assert(node, `Unknown agent node ${String(nodeId)}`);
  const tools = node.toolIds.map(id => {
    const tool = agent.structure!.tools.find(value => value.id === id)!;
    assert(/^[A-Za-z0-9_-]+$/.test(tool.id) && tool.id.length <= maxNameLength, `Tool ${tool.id} is not a valid provider function name (1-${maxNameLength} letters, digits, underscores, or hyphens)`);
    assert(record(tool.inputSchema), `Tool ${tool.id} requires an explicit object inputSchema for provider mapping`);
    return { name: tool.id, description: selected[tool.descriptionKey]!, schema: clone(tool.inputSchema) as ObjectSchema };
  });
  return { prompt: node.promptKeys.map(key => selected[key]!).join('\n\n'), tools };
}

/**
 * Map one declared node to OpenAI Chat Completions configuration only.
 * The application's existing loop still owns messages, tools, limits, and handoffs.
 */
export function mapOpenAIChatConfiguration(agent: AgentTextConfiguration, nodeId: string, components?: Components): OpenAIChatConfiguration {
  const mapped = nodeConfiguration(agent, nodeId, components, 64);
  return {
    messages: [{ role: 'system', content: mapped.prompt }],
    tools: mapped.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } })),
  };
}

/** Map one declared node to Anthropic system/tools configuration; no calls or tool execution. */
export function mapAnthropicConfiguration(agent: AgentTextConfiguration, nodeId: string, components?: Components): AnthropicConfiguration {
  const mapped = nodeConfiguration(agent, nodeId, components, 128);
  return {
    system: mapped.prompt,
    tools: mapped.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.schema })),
  };
}
