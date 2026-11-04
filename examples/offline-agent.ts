import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfflineProposer, defineAgent, type Lane } from '../src/index.ts';

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(path.dirname(exampleRoot)) === 'dist' ? path.resolve(exampleRoot, '../..') : path.resolve(exampleRoot, '..');
const lane: Lane = JSON.parse(readFileSync(path.join(root, 'lanes', 'operations.json'), 'utf8'));

// Demonstrates wiring with no model calls. A real adapter creates fresh agent
// state per evaluation and passes these components into the agent itself.
export const agent = defineAgent<string, string>({
  id: 'offline-example',
  version: '1',
  components: {
    protectedPolicy: lane.protectedPolicy,
    ...Object.fromEntries(Object.entries(lane.genes).map(([key, gene]) => [key, gene.initial])),
  },
  mutable: {
    strategy: { role: 'Operating strategy', maxLength: 3000 },
    searchMode: { role: 'Search output strategy', maxLength: 1000 },
    readStrategy: { role: 'Reading strategy', maxLength: 1000 },
  },
  accounting: { kind: 'free', timeoutMs: 1000 },
  async run({ input, context }) {
    if (context.signal.aborted) throw new Error('Evaluation aborted');
    return { output: input, usage: { complete: true, receipts: [] } };
  },
  optimization: {
    maxAttempts: 1,
    proposer: createOfflineProposer([{ strategy: 'Find relevant files, inspect evidence, and verify changes.' }]),
  },
});
