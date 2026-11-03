import {
  createOfflineProposer, defineAgent, exactMatch, optimize, type Dataset,
} from 'evopt';

const agent = defineAgent<string, string>({
  id: 'offline-category-agent',
  version: '1',
  components: {
    systemPrompt: 'Return the supplied category.',
    lookupToolDescription: 'Look up categories in a fixed catalog.',
  },
  mutable: {
    systemPrompt: { role: 'Category normalization instructions', maxLength: 500 },
    lookupToolDescription: { role: 'Catalog lookup description', maxLength: 300 },
  },
  accounting: { kind: 'free', timeoutMs: 1_000 },
  async run({ input, components, context }) {
    context.signal.throwIfAborted();
    // No conversation memory or external tool state is shared between calls.
    const output = components.systemPrompt!.includes('lowercase')
      ? input.toLowerCase()
      : input;
    return { output, usage: { complete: true, receipts: [] } };
  },
  optimization: {
    proposer: createOfflineProposer<string, string>([
      { systemPrompt: 'Return the supplied category in lowercase.' },
    ]),
    maxAttempts: 1,
  },
});

const dataset: Dataset<string, string> = {
  id: 'offline-categories',
  version: '1',
  train: [{ id: 'train-book', input: 'BOOK', expected: 'book' }],
  validation: [{ id: 'validation-music', input: 'MUSIC', expected: 'music' }],
  test: [{ id: 'test-film', input: 'FILM', expected: 'film' }],
  score: exactMatch,
};

const result = await optimize({ agent, dataset, objective: 'accuracy', budget: 10 });
console.log(JSON.stringify({
  status: result.status,
  changes: result.changes,
  test: result.test,
  occupiedMicros: result.accounting.occupiedMicros,
  evidenceDirectory: result.directory,
  synthetic: result.provenance.synthetic,
}, null, 2));

if (result.status !== 'completed' || result.test?.candidateAccuracy !== 1) {
  throw new Error(`Offline demonstration failed: ${result.reason ?? result.status}`);
}
