#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { loadSWEExperiment } from '../dist/src/swe-experiment.js';
import { checkExperiment, runExperiment, experimentStatus, readExperimentResult, writeNewFile } from '../dist/src/experiments.js';
import { buildSubmission, validateSubmission } from '../dist/src/contributions.js';
import { createConfigurationPatch } from '../dist/src/patch.js';
import { analyzeEvidence } from '../dist/src/evidence.js';

const help = `Evopt SWE-bench contributor workflow: your configured agent, your explicit budget.
  init   --out <config.json> --agent <agent.mjs>
         [--manifest <prepared.json> --source <private-rows.json> --python <absolute-executable>
          --harness <checkout> --revision <commit> --evidence <private-directory>]
  check  --config <config.json> --budget <USD> [--max-tokens <positive-integer>]
  run    --config <config.json> --budget <USD> --out <run-directory>
         [--max-tokens <positive-integer>] [--allow-paid] [--resume]
  status --run <run-directory>
  review --run <run-directory>
  submit --run <run-directory> --out <new-directory> --id <id> --summary <text> --reviewed
init writes configuration only. check verifies local evaluator resources without inference.
run optimizes declared prompt/tool-description text for token savings under resolved-quality gates.
--budget is always the total USD ceiling; --max-tokens is a separate optional run token ceiling.
Paid runs also require --allow-paid. No default provider, budget, downloads or provisioning.
Agent modules are trusted code: imports must never dispatch inference.
submit writes reviewed local artifacts only; it never publishes or opens a pull request.`;
const allowed = {
  init: ['out', 'agent', 'manifest', 'source', 'python', 'harness', 'revision', 'evidence'],
  check: ['config', 'budget', 'max-tokens'], run: ['config', 'budget', 'max-tokens', 'out', 'allow-paid', 'resume'],
  status: ['run'], review: ['run'], submit: ['run', 'out', 'id', 'summary', 'reviewed'],
};
const flags = new Set(['allow-paid', 'resume', 'reviewed']);
function required(options, key) {
  if (typeof options[key] !== 'string' || !options[key].trim()) throw new Error(`--${key} required`);
  return options[key];
}
function parse(command, args) {
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown SWE command');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], key = flag?.slice(2);
    if (!flag?.startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate option ${flag}`);
    options[key] = flags.has(key) ? true : args[++i];
    if (!flags.has(key) && (typeof options[key] !== 'string' || !options[key] || options[key].startsWith('--'))) throw new Error(`Missing --${key} value`);
  }
  return options;
}
function budget(options) {
  const value = required(options, 'budget');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error('--budget must be an explicit positive USD amount');
  const amount = Number(value), micros = Math.floor(amount * 1e6);
  if (!Number.isSafeInteger(micros) || micros < 1) throw new Error('--budget must be at least one USD micro-unit and within the safe numeric range');
  return amount;
}
function maxTokens(options) {
  if (options['max-tokens'] === undefined) return undefined;
  const value = options['max-tokens'];
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--max-tokens must be a positive safe integer');
  return Number(value);
}
function reproductionGuide(submission) {
  const p = submission.provenance, b = p.benchmark;
  const ceiling = submission.accounting.limitMicros / 1e6;
  const tokenFlag = submission.accounting.maxTokens === undefined ? '' : ` --max-tokens ${submission.accounting.maxTokens}`;
  return `# Reviewed Evopt evidence

This directory contains portable evidence (submission.json) and a guarded text configuration patch (patch.json). It does not deploy the patch or authenticate provider invoices. ${p.synthetic ? 'This run is synthetic and is not benchmark evidence.' : 'Independently rerun the evaluator before relying on the reported result.'}

Agent: ${JSON.stringify(p.agentId)} at version ${JSON.stringify(p.agentVersion)}.
Dataset: ${JSON.stringify(p.datasetId)} at version ${JSON.stringify(p.datasetVersion)}.
Run fingerprint: ${p.fingerprint}.
${b ? `Source revision: ${b.sourceRevision}.
Source SHA-256: ${b.sourceSha256}.
Prepared manifest SHA-256: ${b.manifestSha256}.
Evaluator: ${JSON.stringify(b.evaluator.name)} at ${b.evaluator.revision}.
Split policy: ${b.splitPolicy}; metric: ${b.metric}.` : 'No public benchmark provenance was recorded for this run.'}

## Reproduce with reviewed local resources

1. Obtain the exact agent implementation/version and configured proposer, the prepared split manifest, and the private source snapshot through an authorized channel. Match the source and manifest hashes above. Reconstruct the original baseline components, mutable permissions, structure, selection policy, experience settings, model, prices and invocation limits from the submission and reviewed application configuration. Preserve any run token ceiling; do not reuse the opened heldout set to select further candidates.
2. Provision the pinned evaluator checkout, its trusted dependencies, required local repositories at their recorded base commits, and Docker images separately. Obtain private official reports, inference patches and receipts from the contributor when permitted; they are not copied automatically into this public bundle.
3. Configure a trusted named agent export without inference at import. Supply fresh private paths in a new SWE configuration. A new run will create new invocation/report IDs; stochastic model outputs may differ.

\`\`\`sh
npm run swe -- init --out .evopt/reproduction.json --agent ./reviewed-agent.mjs
# Fill manifest, source, interpreter, evaluator revision, and private evidence paths.
npm run swe -- check --config .evopt/reproduction.json --budget ${ceiling}${tokenFlag}
# Only the payer can authorize a new paid run; the command below is a template.
npm run swe -- run --config .evopt/reproduction.json --budget ${ceiling}${tokenFlag} --out .evopt/reproduction-run --allow-paid
npm run swe -- review --run .evopt/reproduction-run
npm run experiment -- validate --file ./submission.json
\`\`\`

The original contributor affirmed review of text, identifiers and receipts. Review this bundle again before redistribution: candidate text and identifiers can contain private material. The exporter does not copy raw task inputs/labels, source snapshots, agent home directories or traces. Never include API keys or provider headers. An empty patch or a null result remains useful evidence; it is not a claim of improvement.
`;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  const o = parse(command, args); let result;
  if (command === 'init') {
    const out = resolve(required(o, 'out')), agentModule = resolve(required(o, 'agent'));
    const config = { version: 1, agentModule, manifest: o.manifest ? resolve(o.manifest) : '<prepared-manifest.json>',
      datasetFile: o.source ? resolve(o.source) : '<private-source.json>',
      harness: { python: o.python ?? '<absolute-python-executable>', cwd: o.harness ? resolve(o.harness) : '<pinned-SWE-bench-checkout>',
        revision: o.revision ?? '<40-character-Git-commit>', evidenceDirectory: o.evidence ? resolve(o.evidence) : './swe-evidence',
        timeoutMs: 3_600_000, instanceTimeoutSeconds: 1800 } };
    await writeNewFile(out, JSON.stringify(config, null, 2) + '\n');
    result = { config: out, agentModule, inferenceRun: false };
  }
  if (command === 'check' || command === 'run') {
    // Validate authorization arguments before importing any trusted application code.
    const config = required(o, 'config'), limit = budget(o), tokens = maxTokens(o);
    const directory = command === 'run' ? required(o, 'out') : undefined;
    const experiment = await loadSWEExperiment(config);
    if (command === 'check') result = { ...checkExperiment(experiment, limit, tokens), objective: experiment.objective, evaluatorReady: true };
    else {
      const controller = new AbortController(), cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const run = await runExperiment(experiment, { budget: limit, directory, ...(tokens === undefined ? {} : { maxTokens: tokens }),
          allowPaid: o['allow-paid'], resume: o.resume, signal: controller.signal });
        result = { status: run.status, ...(run.reason ? { reason: run.reason } : {}), directory: run.directory, test: run.test,
          currency: 'USD', limitMicros: run.accounting.limitMicros, occupiedMicros: run.accounting.occupiedMicros,
          ...(run.accounting.maxTokens === undefined ? {} : { maxTokens: run.accounting.maxTokens, occupiedTokens: run.accounting.occupiedTokens }),
          synthetic: run.provenance.synthetic };
        if (run.status !== 'completed') process.exitCode = 2;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  }
  if (command === 'status') result = await experimentStatus(required(o, 'run'));
  if (command === 'review') result = analyzeEvidence(await readExperimentResult(required(o, 'run')));
  if (command === 'submit') {
    if (o.reviewed !== true) throw new Error('Submission requires --reviewed after reviewing text, identifiers and receipts for sharing');
    const run = required(o, 'run'), out = resolve(required(o, 'out')), id = required(o, 'id'), summary = required(o, 'summary');
    const saved = await readExperimentResult(run), submission = buildSubmission(saved, { id, summary, reviewed: true });
    const validation = validateSubmission(submission), patch = createConfigurationPatch(saved);
    const readme = reproductionGuide(submission);
    await mkdir(dirname(out), { recursive: true }); await mkdir(out, { mode: 0o700 });
    await writeNewFile(join(out, 'submission.json'), JSON.stringify(submission, null, 2) + '\n');
    await writeNewFile(join(out, 'patch.json'), JSON.stringify(patch, null, 2) + '\n');
    await writeNewFile(join(out, 'README.md'), readme);
    result = { directory: out, files: ['submission.json', 'patch.json', 'README.md'], ...validation, published: false, inferenceRun: false };
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(`evopt swe: ${error.message}`); process.exitCode = 1; });
