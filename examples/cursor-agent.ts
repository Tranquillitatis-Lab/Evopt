import { defineCursorAgent, type CursorAgentOptions, type CursorExecutionResult } from '../src/adapters/index.ts';
import type { Components, RunContext } from '../src/index.ts';

/**
 * The application supplies a runner that independently enforces the declared
 * boundary and creates a fresh Cursor agent and workspace for every call.
 */
type RunBoundedCursor = (args: {
  input: string;
  components: Components;
  context: RunContext;
}) => Promise<CursorExecutionResult<string>>;

export function connectCursorAgent(
  settings: Omit<CursorAgentOptions<string, string>, 'run'>,
  runBoundedCursor: RunBoundedCursor,
) {
  return defineCursorAgent<string, string>({
    ...settings,
    async run(args) {
      // The runner must return complete, settled usage scoped to this run,
      // including the SDK's billed cost and every applicable charge.
      return runBoundedCursor(args);
    },
  });
}
