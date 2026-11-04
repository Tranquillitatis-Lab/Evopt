import { defineOpenAIAgent, type ProviderAgentOptions, type ProviderAgentResult } from '../src/adapters/index.ts';
import type { Limits } from '../src/index.ts';

/** The application owns the agent, provider client, and fresh state for each call. */
type RunFreshAgent = (args: {
  input: string;
  systemPrompt: string;
  signal: AbortSignal;
  limits: Readonly<Limits>;
}) => Promise<ProviderAgentResult<string>>;

/** Supply application settings, including the model, proposer and paid accounting envelope. */
export function connectAgent(
  settings: Omit<ProviderAgentOptions<string, string>, 'run'>,
  runFreshAgent: RunFreshAgent,
) {
  return defineOpenAIAgent<string, string>({
    ...settings,
    async run({ input, components, context }) {
      if (!context.limits) throw new Error('Paid invocation limits are required');
      // Return every raw billed response and explicitly report completeness and paid tools.
      return runFreshAgent({ input, systemPrompt: components.systemPrompt, signal: context.signal, limits: context.limits });
    },
  });
}
