import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracyStrategy, createOfflineProposer, defineAgent, exactMatch, optimize,
  type Agent, type Dataset, type OptimizationResult, type RunContext, type Components,
} from 'evopt';

type Input = { text: string; request: number };
type Output = { label: string; confidence: number };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// These checks are compiled by npm test but intentionally perform no optimization.
function checkPublicTypes(): void {
  const agent = defineAgent<Input, Output>({
    id: 'typed', version: '1', components: { prompt: 'Classify.' },
    mutable: { prompt: { role: 'Classifier', maxLength: 100 } },
    accounting: { kind: 'free', timeoutMs: 1_000 },
    optimization: { proposer: createOfflineProposer<Input, Output>([]) },
    async run({ input, context }) {
      const typedInput: Input = input;
      const signal: AbortSignal = context.signal;
      signal.throwIfAborted();
      // @ts-expect-error Input retains its structure instead of becoming any.
      const wrong: string = input;
      void wrong;
      return { output: { label: typedInput.text, confidence: 1 }, usage: { complete: true, receipts: [] } };
    },
  });
  type PreservedAgent = Expect<Equal<typeof agent, Agent<Input, Output>>>;
  const preserved: PreservedAgent = true;
  void preserved;
  const dataset: Dataset<Input, Output> = {
    id: 'typed-data', version: '1',
    train: [{ id: 'train', input: { text: 'a', request: 1 }, expected: { label: 'a', confidence: 1 } }],
    validation: [{ id: 'validation', input: { text: 'b', request: 2 }, expected: { label: 'b', confidence: 1 } }],
    test: [{ id: 'test', input: { text: 'c', request: 3 }, expected: { label: 'c', confidence: 1 } }],
    score({ input, output, expected }) {
      const request: number = input.request;
      const confidence: number = output.confidence;
      // @ts-expect-error Scorer output remains the declared output type.
      const wrong: number = output.label;
      void [request, confidence, wrong];
      return exactMatch({ output, expected });
    },
  };
  const result = optimize({ agent, dataset, objective: 'accuracy', budget: 10 });
  type PreservedResult = Expect<Equal<typeof result, Promise<OptimizationResult<Output>>>>;
  const preservedResult: PreservedResult = true;
  void preservedResult;
  result.then(value => {
    const output: Output | undefined = value.evaluations[0]?.output;
    // @ts-expect-error Result evaluations do not erase the output type.
    const wrong: string | undefined = value.evaluations[0]?.output;
    void [output, wrong];
  });
  const wrongDataset: Dataset<number, number> = {
    id: 'wrong', version: '1', train: [], validation: [], test: [], score: exactMatch,
  };
  // @ts-expect-error Dataset input/output must match the configured agent.
  void optimize({ agent, dataset: wrongDataset, objective: 'accuracy', budget: 10 });
  // @ts-expect-error Only the supported objective is accepted publicly.
  void optimize({ agent, dataset, objective: 'latency', budget: 10 });
  // @ts-expect-error Scorers produce pass/fail, not numeric scores.
  const wrongScorer: Dataset<Input, Output>['score'] = () => 0.5;
  void wrongScorer;

  // A normally typed application callback supplies inference without explicit
  // defineAgent or optimize type arguments.
  const inferred = defineAgent({
    id: 'inferred', version: '1', components: { prompt: 'Classify.' },
    mutable: { prompt: { role: 'Classifier', maxLength: 100 } },
    accounting: { kind: 'free', timeoutMs: 1_000 },
    optimization: { proposer: createOfflineProposer<Input, Output>([]) },
    async run({ input }: { input: Input; components: Components; context: RunContext }) {
      return {
        output: { label: input.text, confidence: 1 },
        usage: { complete: true as const, receipts: [] },
      };
    },
  });
  type InferredAgent = Expect<Equal<typeof inferred, Agent<Input, Output>>>;
  const inferredAgent: InferredAgent = true;
  void inferredAgent;
  const inferredResult = optimize({ agent: inferred, dataset, objective: 'accuracy', budget: 10 });
  type InferredResult = Expect<Equal<typeof inferredResult, Promise<OptimizationResult<Output>>>>;
  const inferredOutput: InferredResult = true;
  void inferredOutput;
}
void checkPublicTypes;

test('root package exports the complete public entry points', () => {
  for (const value of [optimize, defineAgent, exactMatch, createOfflineProposer]) {
    assert.equal(typeof value, 'function');
  }
  assert.equal(typeof accuracyStrategy.select, 'function');
  assert.equal(exactMatch({ output: { a: 1 }, expected: { a: 1 } }), true);
  assert.equal(exactMatch({ output: 'A', expected: 'a' }), false);
});
