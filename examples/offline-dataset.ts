// Synthetic data exercises the workflow without paying for inference.
export const dataset = {
  id: 'offline-example', version: '1',
  train: [{ id: 'train', input: 'Find the config file', expected: 'Find the config file' }],
  validation: [{ id: 'validation', input: 'Inspect the failing test', expected: 'Inspect the failing test' }],
  test: [{ id: 'test', input: 'Verify the patch', expected: 'Verify the patch' }],
  score: ({ output, expected }: { output: string; expected: string }) => output === expected,
};
