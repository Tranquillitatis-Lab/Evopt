#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { runSearch, validateFinal, exportWinner, readState } from '../src/search.ts';
import { analyzeRun } from '../src/evidence.ts';
import { verifySubmission } from '../src/submission.ts';
import { importSWE } from '../benchmarks/import-swe.ts';

const help = `Evopt: optimize prompts and tool descriptions for your agent
Usage: node bin/evopt.ts <command> [options]
  init       Write a starter config: --out <file> --budget-usd <amount>
  doctor     Check configuration without inference
  preflight  Show task counts and budget without inference
  run        Search training and validation tasks
  validate   Freeze winners and evaluate held-out tasks
  status     Inspect run state
  analyze    Analyze private evidence: --run-dir <directory> --out <directory>
  export     Export a lane's result: --lane <id> --out <file>
  verify     Check an exported result: --file <file>
  benchmark  Prepare a SWE-bench manifest: --input <file> --settings <file> --out <file>
Options: --config <file> --lane <id> --out <file> --help
`;

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  requireValue(['init', 'doctor', 'preflight', 'run', 'validate', 'status', 'analyze', 'export', 'verify', 'benchmark'].includes(command), 'Unknown command');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    requireValue(['--config', '--lane', '--out', '--run-dir', '--budget-usd', '--file', '--input', '--settings'].includes(key), `Unknown option ${key}`);
    requireValue(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${key}`);
    requireValue(options[key] === undefined, `Duplicate option ${key}`);
    options[key] = args[++i];
  }
  if (command === 'init') {
    requireValue(options['--out'], 'init requires --out');
    const maxUSD = Number(options['--budget-usd']);
    requireValue(Number.isFinite(maxUSD) && maxUSD > 0, 'init requires a positive --budget-usd');
    const appRoot = fileURLToPath(new URL('..', import.meta.url));
    const root = path.basename(appRoot) === 'dist' ? path.dirname(appRoot) : appRoot;
    const config = { version: 1, agentModule: path.join(root, 'dist', 'examples', 'offline-agent.js'), datasetModule: path.join(root, 'dist', 'examples', 'offline-dataset.js'), lanes: [path.join(root, 'lanes', 'operations.json')], output: path.resolve(path.dirname(options['--out']), '.evopt-run'), budget: { maxUSD }, seed: 42, search: { population: 4, generations: 2, elites: 2, llmMutation: false }, evaluation: { repetitions: 1, order: 'balanced' } };
    await writeFile(options['--out'], JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ file: path.resolve(options['--out']), inferenceRun: false }, null, 2)); return;
  }
  if (command === 'analyze') {
    requireValue(options['--run-dir'] && options['--out'], 'analyze requires --run-dir and --out');
    console.log(JSON.stringify(await analyzeRun(options['--run-dir'], options['--out']), null, 2)); return;
  }
  if (command === 'verify') {
    requireValue(options['--file'], 'verify requires --file');
    console.log(JSON.stringify(await verifySubmission(options['--file']), null, 2)); return;
  }
  if (command === 'benchmark') {
    requireValue(options['--input'] && options['--settings'] && options['--out'], 'benchmark requires --input, --settings and --out');
    const settings = JSON.parse(await readFile(options['--settings'], 'utf8'));
    const result = await importSWE(options['--input'], options['--out'], settings);
    console.log(JSON.stringify({ tasks: result.tasks, output: path.resolve(options['--out']), inferenceRun: false }, null, 2)); return;
  }
  requireValue(options['--config'], '--config required');
  const config = await readConfig(options['--config']);
  const lanes = options['--lane'] ? config.lanes.filter((lane: { id: string }) => lane.id === options['--lane']) : config.lanes;
  requireValue(lanes.length, 'Unknown lane');
  if (command === 'doctor') {
    console.log(JSON.stringify({ valid: true, inferenceRun: false, lanes: lanes.map((lane: { id: string }) => lane.id), output: config.output }, null, 2)); return;
  }
  if (command === 'preflight') {
    const counts = Object.fromEntries((['train', 'validation', 'test'] as const).map(split => [split, config.dataset[split].length]));
    console.log(JSON.stringify({ inferenceRun: false, tasks: counts, repetitions: config.evaluation.repetitions, budget: config.budget, lanes: lanes.map((lane: { id: string }) => lane.id) }, null, 2)); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await readState(config), null, 2)); return; }
  if (command === 'export') requireValue(options['--lane'] && options['--out'], 'export requires --lane and --out');
  for (const lane of lanes) {
    let result: unknown;
    if (command === 'run') result = await runSearch(config, lane);
    if (command === 'validate') result = await validateFinal(config, lane);
    if (command === 'export') result = await exportWinner(config, lane, path.resolve(options['--out']));
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch((error: Error) => { console.error(`evopt: ${error.message}`); process.exitCode = 1; });
