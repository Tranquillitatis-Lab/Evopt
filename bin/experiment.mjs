#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkExperiment, runExperiment, experimentStatus, readExperimentResult, writeNewFile } from '../dist/src/experiments.js';
import { buildSubmission, validateSubmission } from '../dist/src/contributions.js';
import { listAssistants, resolveAssistant, renderAssistantBrief } from '../dist/src/assistants.js';
import { listProviders, resolveProvider, listFrameworkBridges } from '../dist/src/integrations.js';

const help = `Evopt contributor experiments: bounded text optimization for any configured agent.
  integrations                               Show providers, assistants, and SDK support boundaries
  onboard   --assistant <name> --out <brief.md>  Write an assistant-specific contributor brief
  init      --out <experiment.mjs> [--provider <name> --settings <private.json>]
                                             Create a scaffold; default offline, never inference
  check     --config <experiment.mjs> [--budget <USD>]   Validate and show cost bounds
  run       --config <experiment.mjs> --budget <USD> --out <run-dir> [--allow-paid] [--resume]
  status    --run <run-dir>                   Read checkpoint without loading an agent
  export    --run <run-dir> --out <submission.json> --id <id> --summary <text> --reviewed
  validate  --file <submission.json>          Validate portable evidence; no inference
Paid runs require both an explicit budget and --allow-paid. No default budget or provider.
Config modules are trusted application code: imports must never perform inference.
Export --reviewed attests that the contributor reviewed the included text and identifiers.
No command publishes, merges, installs, or changes a production configuration.`;
const allowed = {
  integrations: [], onboard: ['assistant','out'], init: ['out','provider','settings'], check: ['config','budget'], run: ['config','budget','out','allow-paid','resume'],
  status: ['run'], export: ['run','out','id','summary','reviewed'], validate: ['file'],
};
const flags = new Set(['allow-paid','resume','reviewed']);
function required(options, key) { if (typeof options[key] !== 'string' || !options[key].trim()) throw new Error(`--${key} required`); return options[key]; }
function parse(command, args) {
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate option ${args[i]}`);
    options[key] = flags.has(key) ? true : args[++i];
    if (!flags.has(key) && (!options[key] || options[key].startsWith('--'))) throw new Error(`Missing --${key} value`);
  }
  return options;
}
async function load(config) { return (await import(pathToFileURL(resolve(config)).href)).default; }
function scaffold() {
  const entry = new URL('../dist/src/index.js', import.meta.url).href;
  return `// Trusted local configuration. Do not run inference at module import.
// This absolute import points at this checkout; review it when sharing the module.
import { defineAgent, defineExperiment, createOfflineProposer, exactMatch } from ${JSON.stringify(entry)};

export default defineExperiment({
  id: 'category-normalization',
  description: 'Offline contributor workflow demonstration; not benchmark evidence.',
  objective: 'accuracy',
  agent: defineAgent({
    id: 'category-agent', version: '1',
    components: { systemPrompt: 'Return the supplied category.', lookupToolDescription: 'Look up a category in a fixed catalog.' },
    mutable: { systemPrompt: { role: 'Category normalization', maxLength: 500 }, lookupToolDescription: { role: 'Catalog lookup description', maxLength: 300 } },
    accounting: { kind: 'free', timeoutMs: 1000 },
    async run({ input, components, context }) {
      context.signal.throwIfAborted();
      return { output: components.systemPrompt.includes('lowercase') ? input.toLowerCase() : input,
        usage: { complete: true, receipts: [] } };
    },
    optimization: { maxAttempts: 1, proposer: createOfflineProposer([{ systemPrompt: 'Return the supplied category in lowercase.' }]) },
  }),
  dataset: { id: 'category-fixtures', version: '1', score: exactMatch,
    train: [{ id: 'train-book', input: 'BOOK', expected: 'book' }],
    validation: [{ id: 'validation-music', input: 'MUSIC', expected: 'music' }],
    test: [{ id: 'test-film', input: 'FILM', expected: 'film' }],
  },
});
`;
}
function providerScaffold(provider, settings) {
  const entry = new URL('../dist/src/index.js', import.meta.url).href;
  const names = {
    openai: ['openai','createOpenAITextRunner','createOpenAIProposer'],
    anthropic: ['anthropic','createAnthropicTextRunner','createAnthropicProposer'],
    gemini: ['gemini','createGeminiTextRunner','createGeminiProposer'],
    'openai-compatible': ['openai','createOpenAICompatibleTextRunner','createOpenAICompatibleProposer'],
  };
  const [module, runner, proposer] = names[provider];
  const providerEntry = new URL(`../dist/src/${module}.js`, import.meta.url).href;
  return `// Trusted local experiment. Import validates settings but never sends requests.
import { readFile } from 'node:fs/promises';
import { defineAgent, defineExperiment, exactMatch } from ${JSON.stringify(entry)};
import { ${runner}, ${proposer} } from ${JSON.stringify(providerEntry)};
const config = JSON.parse(await readFile(${JSON.stringify(resolve(settings))}, 'utf8'));
if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 0) throw new Error('Explicit maxAttempts required');
const target = ${runner}({ ...config, promptKey: 'systemPrompt' });
export default defineExperiment({
  id: ${JSON.stringify(provider + '-text-smoke')},
  description: 'Paid text wiring demonstration, not a representative benchmark or a guaranteed improvement.',
  objective: 'accuracy',
  agent: defineAgent({
    id: ${JSON.stringify(provider + '-text')}, version: '1',
    components: { systemPrompt: 'Normalize the category name. Return only the normalized category.' },
    mutable: { systemPrompt: { role: 'Category normalization', maxLength: 1000 } },
    ...target,
    optimization: { proposer: ${proposer}(config), maxAttempts: config.maxAttempts },
  }),
  dataset: { id: 'public-category-smoke', version: '1', score: exactMatch,
    train: [{ id: 'train-books', input: ' BOOKS ', expected: 'books' }],
    validation: [{ id: 'validation-music', input: ' MUSIC ', expected: 'music' }],
    test: [{ id: 'test-film', input: ' FILM ', expected: 'film' }],
  },
});
`;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  const o = parse(command, args);
  let result;
  if (command === 'integrations') result = { providers: listProviders(), assistants: listAssistants(), frameworks: listFrameworkBridges() };
  if (command === 'onboard') {
    const assistant = resolveAssistant(required(o, 'assistant')), path = required(o, 'out');
    await writeNewFile(path, renderAssistantBrief(assistant.id));
    result = { assistant: assistant.name, brief: resolve(path), inferenceRun: false, launchedAssistant: false };
  }
  if (command === 'init') {
    const path = required(o, 'out'), provider = resolveProvider(o.provider ?? 'offline');
    if (provider === 'offline' && o.settings) throw new Error('Offline scaffold does not use --settings');
    const source = provider === 'offline' ? scaffold() : providerScaffold(provider, required(o, 'settings'));
    await writeNewFile(path, source); result = { config: resolve(path), provider, inferenceRun: false };
  }
  if (command === 'check') result = checkExperiment(await load(required(o, 'config')), o.budget === undefined ? undefined : Number(o.budget));
  if (command === 'run') {
    const config = required(o, 'config'), budget = Number(required(o, 'budget')), directory = required(o, 'out');
    const controller = new AbortController(); const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const run = await runExperiment(await load(config), { budget, directory, allowPaid: o['allow-paid'], resume: o.resume, signal: controller.signal });
      result = { status: run.status, reason: run.reason, directory: run.directory, test: run.test, occupiedMicros: run.accounting.occupiedMicros, synthetic: run.provenance.synthetic };
      if (run.status !== 'completed') process.exitCode = 2;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
  if (command === 'status') result = await experimentStatus(required(o, 'run'));
  if (command === 'export') {
    if (!o.reviewed) throw new Error('Export requires --reviewed after reviewing text, identifiers, and receipts for privacy');
    const output = required(o, 'out'), id = required(o, 'id'), summary = required(o, 'summary');
    const submission = buildSubmission(await readExperimentResult(required(o, 'run')), { id, summary, reviewed: true });
    await writeNewFile(output, JSON.stringify(submission, null, 2) + '\n'); result = validateSubmission(submission);
  }
  if (command === 'validate') result = validateSubmission(JSON.parse(await readFile(required(o, 'file'), 'utf8')));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(`evopt experiment: ${error.message}`); process.exitCode = 1; });
