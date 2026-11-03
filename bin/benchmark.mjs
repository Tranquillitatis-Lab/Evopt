#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareSWE, createSWEDataset, listBenchmarks,
  validateSWEManifest, assertSWESourceMatches, evaluateSWE } from '../dist/benchmarks/index.js';
import { writeNewFile } from '../dist/src/experiments.js';

const help = `Evopt benchmark preparation, evaluator checks, and patch grading. No model inference.
  list
  prepare --benchmark swe-bench --source <local-rows.json> --sha256 <file-hash> --revision <dataset-commit>
          --dataset <SWE-bench/SWE-bench_Lite> --source-split test --repositories <absolute-local-repo-root>
          --splits <JSON> --out <manifest.json>
  check   --manifest <manifest.json> --python <absolute-python-executable>
          --harness <evaluator-checkout-root> --revision <evaluator-commit> --evidence <private-dir>
          --source <private-SWE-rows.json> [--timeout-ms <milliseconds>] [--instance-timeout-seconds <seconds>]
  evaluate --manifest <SWE-manifest.json> --source <private-SWE-rows.json> --python <absolute-python-executable>
          --harness <SWE-bench-checkout-root> --revision <evaluator-commit> --evidence <private-dir>
          --instance <selected-instance-id> --patch <local-patch.diff> --run-id <unique-id>
          [--timeout-ms <milliseconds>] [--instance-timeout-seconds <seconds>]
All revisions are full 40-character Git commit IDs; split keys are explicit string arrays.
The importer preserves custom train/validation/test groups; results are not official leaderboard scores.
check verifies trusted local evaluator resources without invoking an agent.
evaluate runs the official local Docker harness on a supplied SWE patch; provision images beforehand.`;
const evaluatorFlags = ['manifest','source','python','harness','revision','evidence','timeout-ms','instance-timeout-seconds'];
const allowed = { list: [], prepare: ['benchmark','source','sha256','revision','splits','out','dataset','source-split','repositories'],
  check: evaluatorFlags, evaluate: [...evaluatorFlags, 'instance','patch','run-id'] };
function required(o, key) { if (typeof o[key] !== 'string' || !o[key].trim()) throw new Error(`--${key} required`); return o[key]; }
function parse(command, args) {
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown benchmark command');
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], key = flag?.slice(2), value = args[++i];
    if (!flag?.startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(o, key)) throw new Error(`Unknown or duplicate option ${flag}`);
    if (!value || value.startsWith('--')) throw new Error(`Missing --${key} value`);
    o[key] = value;
  }
  return o;
}
function summarize(manifest) {
  return { benchmark: manifest.id, metric: manifest.metric, source: manifest.source, splitPolicy: manifest.splitPolicy,
    cases: Object.fromEntries(Object.entries(manifest.partitions).map(([split, rows]) => [split, rows.length])) };
}
function harnessOptions(o) {
  return { python: required(o, 'python'), cwd: resolve(required(o, 'harness')), revision: required(o, 'revision'),
    evidenceDirectory: resolve(required(o, 'evidence')), ...(o['timeout-ms'] ? { timeoutMs: Number(o['timeout-ms']) } : {}),
    ...(o['instance-timeout-seconds'] ? { instanceTimeoutSeconds: Number(o['instance-timeout-seconds']) } : {}) };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  const o = parse(command, args); let result;
  if (command === 'list') result = { benchmarks: listBenchmarks(), inferenceRun: false };
  if (command === 'prepare') {
    const benchmark = required(o, 'benchmark');
    if (benchmark !== 'swe-bench') throw new Error('Only the SWE-bench importer is implemented; inspect list for assessed benchmarks');
    const destination = required(o, 'out');
    const common = { sourceFile: resolve(required(o, 'source')), sourceSha256: required(o, 'sha256'),
      sourceRevision: required(o, 'revision'), groups: JSON.parse(await readFile(required(o, 'splits'), 'utf8')) };
    const manifest = await prepareSWE({ ...common, dataset: required(o, 'dataset'), sourceSplit: required(o, 'source-split'), repositoryRoot: required(o, 'repositories') });
    await writeNewFile(destination, JSON.stringify(manifest, null, 2) + '\n');
    result = { ...summarize(manifest), manifest: resolve(destination), inferenceRun: false };
  }
  if (command === 'check') {
    const manifest = JSON.parse(await readFile(required(o, 'manifest'), 'utf8'));
    validateSWEManifest(manifest);
    const settings = harnessOptions(o);
    const dataset = await createSWEDataset(manifest, { ...settings, datasetFile: resolve(required(o, 'source')) });
    result = { ...summarize(manifest), datasetVersion: dataset.version, evaluator: dataset.benchmark?.evaluator,
      inferenceRun: false, evaluatorReady: true };
  }
  if (command === 'evaluate') {
    const manifest = JSON.parse(await readFile(required(o, 'manifest'), 'utf8'));
    validateSWEManifest(manifest);
    const instanceId = required(o, 'instance');
    if (!Object.values(manifest.partitions).flat().some(task => task.id === instanceId)) throw new Error('Instance is outside the prepared manifest');
    const datasetFile = resolve(required(o, 'source'));
    await assertSWESourceMatches(manifest, datasetFile);
    const grade = await evaluateSWE(harnessOptions(o), { datasetFile, datasetSha256: manifest.source.sha256,
      split: manifest.source.split, instanceId, patch: await readFile(required(o, 'patch'), 'utf8'), runId: required(o, 'run-id') });
    result = { ...grade, instanceId, inferenceRun: false };
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(`evopt benchmark: ${error.message}`); process.exitCode = 1; });
