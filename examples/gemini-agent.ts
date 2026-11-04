import { defineGeminiAgent, type GeminiAgentOptions, type GeminiAgentResult } from '../src/adapters/index.ts';
import type { Components, RunContext } from '../src/index.ts';

/** The application creates fresh agent state and enforces the supplied limits. */
type RunFreshGemini = (args: {
  input: string;
  components: Components;
  context: RunContext;
}) => Promise<GeminiAgentResult<string>>;

export function connectGeminiAgent(
  settings: Omit<GeminiAgentOptions<string, string>, 'run'>,
  runFreshGemini: RunFreshGemini,
) {
  return defineGeminiAgent<string, string>({
    ...settings,
    async run(args) {
      // Report every billed response, whether usage is complete, and whether
      // the run was text-only and avoided paid tools and explicit cache storage.
      return runFreshGemini(args);
    },
  });
}
