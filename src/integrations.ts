export type ProviderId = 'offline' | 'openai' | 'anthropic' | 'gemini' | 'openai-compatible';
const providers = [
  { id: 'offline', name: 'Deterministic offline', kind: 'offline', module: null, target: true, proposer: true },
  { id: 'openai', name: 'OpenAI API', kind: 'model-api', module: 'evopt/openai', target: true, proposer: true },
  { id: 'anthropic', name: 'Anthropic Claude API', kind: 'model-api', module: 'evopt/anthropic', target: true, proposer: true },
  { id: 'gemini', name: 'Google Gemini API', kind: 'model-api', module: 'evopt/gemini', target: true, proposer: true },
  { id: 'openai-compatible', name: 'Explicit OpenAI-compatible API', kind: 'model-api', module: 'evopt/openai', target: true, proposer: true },
] as const;
export function listProviders() { return providers.map(p => ({ ...p, scope: p.id === 'offline' ? 'Synthetic offline demonstration' : 'Bounded single-request text runner and candidate proposer; not a coding-agent runtime' })); }
export function resolveProvider(name: string): ProviderId {
  const alias: Record<string, ProviderId> = { claude: 'anthropic', google: 'gemini', compatible: 'openai-compatible' };
  const normalized = name.trim().toLowerCase(), id = alias[normalized] ?? normalized;
  if (!providers.some(p => p.id === id)) throw new Error(`Unsupported metered provider: ${name}. Coding assistants such as Codex, Claude Code, and Cursor use 'onboard --assistant'; SDK targets require a separately metered defineAgent adapter.`);
  return id as ProviderId;
}
export function listFrameworkBridges() {
  return ['OpenAI Agents SDK', 'Claude Agent SDK', 'Codex SDK', 'Cursor SDK', 'LangGraph', 'Vercel AI SDK', 'Mastra'].map(name => ({
    name, status: 'custom-adapter-required', automaticTarget: false,
    requirements: ['Fresh invocation state', 'Bounded mutable text wired to real prompts/tool descriptions', 'Complete normalized receipts', 'Enforced envelope for every model step and paid tool'],
    entryPoint: 'defineAgent',
  }));
}
