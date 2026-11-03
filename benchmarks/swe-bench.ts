import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessFailure, runProcess, verifyHarness, type HarnessPin } from './harness.js';

export interface SWEHarnessOptions extends HarnessPin {
  evidenceDirectory: string;
  instanceTimeoutSeconds?: number;
}
export interface SWEDatasetSelection {
  datasetFile: string;
  datasetSha256: string;
  split: string;
  instanceIds: string[];
}
export interface SWEEvaluationInput extends Omit<SWEDatasetSelection, 'instanceIds'> {
  instanceId: string;
  patch: string;
  runId?: string;
}
export interface SWEEvaluationResult { passed: boolean; runId: string; report: string; reportSha256: string }

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const inside = (root: string, child: string): boolean => {
  const path = relative(root, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 200
  && /^[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) && !id.includes('..');
const privateFile = { flag: 'wx', mode: 0o600 } as const;

// Fixed trusted infrastructure checks; candidate text is only written to prediction JSON.
// Importing the pinned official module checks its dependencies without starting evaluation.
const preflightCode = `import hashlib, json, sys
from pathlib import Path
import docker
import swebench.harness.run_evaluation as evaluator
from swebench.harness.utils import load_swebench_dataset
root = Path.cwd().resolve()
if Path(evaluator.__file__).resolve() != root / 'swebench' / 'harness' / 'run_evaluation.py':
    raise RuntimeError('Imported evaluator is outside the pinned checkout')
client = docker.from_env()
try:
    if not client.ping():
        raise RuntimeError('Docker daemon did not acknowledge ping')
    if len(sys.argv) > 1:
        source, expected_hash, split, ids_json = sys.argv[1:]
        raw = Path(source).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_hash:
            raise RuntimeError('Local dataset SHA-256 changed')
        ids = json.loads(ids_json)
        text = raw.decode('utf-8')
        source_rows = json.loads(text) if text.lstrip().startswith('[') else [json.loads(line) for line in text.splitlines() if line.strip()]
        expected = {row['instance_id']: row for row in source_rows}
        rows = load_swebench_dataset(source, split, ids)
        if len(rows) != len(ids) or {row['instance_id'] for row in rows} != set(ids):
            raise RuntimeError('Pinned dataset loader returned different instance IDs')
        for row in rows:
            if row != expected[row['instance_id']]:
                raise RuntimeError('Pinned dataset loader changed a selected row')
            spec = evaluator.make_test_spec(row)
            image = getattr(spec, 'image', None) or getattr(spec, 'instance_image_key', None)
            if not isinstance(image, str) or not image:
                raise RuntimeError('Pinned harness has no supported local image identifier')
            client.images.get(image)
    print('SWE-bench local harness preflight passed')
finally:
    client.close()
`;

function configuration(options: SWEHarnessOptions): SWEHarnessOptions {
  assert(record(options), 'Missing SWE-bench harness options');
  assert(typeof options.cwd === 'string' && isAbsolute(options.cwd), 'Pin an absolute SWE-bench checkout');
  assert(typeof options.evidenceDirectory === 'string' && options.evidenceDirectory.trim(), 'SWE-bench evidence directory required');
  const config = { ...options, cwd: resolve(options.cwd), evidenceDirectory: resolve(options.evidenceDirectory) };
  assert(!inside(config.cwd, config.evidenceDirectory), 'SWE-bench evidence directory must be outside the evaluator checkout');
  for (const [name, value] of [['timeoutMs', config.timeoutMs], ['instanceTimeoutSeconds', config.instanceTimeoutSeconds]] as const) {
    assert(value === undefined || Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647, `Invalid SWE-bench ${name}`);
  }
  return config;
}

async function sourceBytes(selection: SWEDatasetSelection): Promise<Buffer> {
  assert(record(selection), 'SWE-bench local dataset selection required');
  assert(typeof selection.datasetFile === 'string' && selection.datasetFile.trim(), 'Local SWE-bench dataset file required');
  assert(typeof selection.datasetSha256 === 'string' && /^[a-f0-9]{64}$/.test(selection.datasetSha256), 'Pin SWE-bench dataset SHA-256');
  assert(typeof selection.split === 'string' && /^[A-Za-z0-9_-]+$/.test(selection.split), 'Invalid SWE-bench split');
  assert(Array.isArray(selection.instanceIds) && selection.instanceIds.length > 0 && selection.instanceIds.every(validId), 'Invalid SWE-bench instance IDs');
  assert(new Set(selection.instanceIds).size === selection.instanceIds.length, 'Duplicate SWE-bench selected instance IDs');
  const bytes = await readFile(resolve(selection.datasetFile));
  assert(sha256(bytes) === selection.datasetSha256, 'SWE-bench dataset SHA-256 mismatch');
  const text = bytes.toString('utf8');
  const rows: unknown = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  assert(Array.isArray(rows) && rows.length > 0, 'SWE-bench local snapshot must contain nonempty JSON or JSONL rows');
  const ids = new Set<string>();
  for (const row of rows) {
    assert(record(row) && validId(row.instance_id), 'Invalid SWE-bench local dataset row');
    assert(!ids.has(row.instance_id), 'Duplicate SWE-bench local dataset instance ID');
    ids.add(row.instance_id);
  }
  assert(selection.instanceIds.every(id => ids.has(id)), 'Selected SWE-bench instance is missing from the local dataset');
  return bytes;
}

const snapshotName = (bytes?: Buffer): string => !bytes || bytes.toString('utf8').trimStart().startsWith('[') ? 'dataset.json' : 'dataset.jsonl';

async function claimEvidence(config: SWEHarnessOptions, runId: string): Promise<string> {
  await mkdir(config.evidenceDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(config.cwd), evidence = await realpath(config.evidenceDirectory);
  assert(!inside(root, evidence), 'SWE-bench evidence directory must be outside the evaluator checkout');
  const directory = join(evidence, runId);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { throw new Error('SWE-bench evidence run ID already exists or cannot be created; refusing reuse', { cause: error }); }
  return directory;
}

async function diagnostics(directory: string, value: { stdout: string; stderr: string }, prefix = ''): Promise<void> {
  await writeFile(join(directory, `${prefix}stdout.txt`), value.stdout, privateFile);
  await writeFile(join(directory, `${prefix}stderr.txt`), value.stderr, privateFile);
}

async function preflight(config: SWEHarnessOptions, selection?: SWEDatasetSelection, snapshot?: string): Promise<{ stdout: string; stderr: string }> {
  const args = ['-X', 'utf8', '-c', preflightCode];
  if (selection) args.push(snapshot!, selection.datasetSha256, selection.split, JSON.stringify(selection.instanceIds));
  return runProcess(config.python, args, { cwd: config.cwd, timeoutMs: config.timeoutMs ?? 60_000, maxBytes: 4 * 1024 * 1024 });
}

/** Check reviewed local dependencies, Docker connectivity, and optional selected rows/images. Never pulls or builds images. */
export async function checkSWEHarness(options: SWEHarnessOptions, dataset?: SWEDatasetSelection): Promise<void> {
  const config = configuration(options), bytes = dataset ? await sourceBytes(dataset) : undefined;
  const directory = await claimEvidence(config, `preflight-${randomUUID()}`);
  let output = { stdout: '', stderr: '' }, failure: unknown;
  try {
    await verifyHarness(config, 'swebench');
    const snapshot = join(directory, snapshotName(bytes));
    if (bytes) await writeFile(snapshot, bytes, privateFile);
    output = await preflight(config, dataset, snapshot);
    await verifyHarness(config, 'swebench');
  } catch (error) { failure = error; if (error instanceof ProcessFailure) output = error; }
  await diagnostics(directory, output);
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ format: 1, benchmark: 'swe-bench', kind: 'preflight-only',
    status: failure ? 'infrastructure-failed' : 'completed', evaluatorRevision: config.revision,
    datasetSha256: dataset?.datasetSha256, split: dataset?.split, instanceIds: dataset?.instanceIds, inferenceRun: false,
    error: failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure) }, null, 2) + '\n', privateFile);
  if (failure) throw new Error(`SWE-bench preflight failed (evidence: ${directory}): ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
}

async function parseReport(bytes: Buffer, instanceId: string, patch: string, patchFailureLog: () => Promise<Buffer>): Promise<{ passed: boolean; reason?: 'patch-application-failed' }> {
  const report: unknown = JSON.parse(bytes.toString('utf8'));
  assert(record(report), 'SWE-bench report must be an object');
  const required = ['submitted', 'completed', 'resolved', 'unresolved', 'empty_patch', 'error'];
  const optional = ['incomplete', 'infra_failure', 'ambiguous_failure'];
  const sets = new Map<string, string[]>();
  for (const key of [...required, ...optional]) {
    const value = report[`${key}_ids`] === undefined && optional.includes(key) ? [] : report[`${key}_ids`];
    assert(Array.isArray(value) && value.every(id => id === instanceId) && new Set(value).size === value.length, `SWE-bench report has invalid ${key} IDs`);
    if (report[`${key}_instances`] !== undefined) assert(report[`${key}_instances`] === value.length, `SWE-bench report has inconsistent ${key} count`);
    sets.set(key, value);
  }
  if (report.total_instances !== undefined) assert(report.total_instances === 1, 'SWE-bench report contains a different instance selection');
  const has = (key: string): boolean => sets.get(key)!.length === 1;
  assert(has('submitted'), 'SWE-bench report is missing the submitted instance');
  assert(!['incomplete', 'infra_failure', 'ambiguous_failure'].some(has), 'SWE-bench report records an infrastructure or ambiguous failure');
  if (has('error')) {
    assert(patch !== '' && !['completed', 'resolved', 'unresolved', 'empty_patch'].some(has), 'SWE-bench error report is inconsistent');
    const log = await patchFailureLog();
    // Match the official logger's complete INFO message, never an arbitrary mention
    // of the marker in stderr, patch text, or a traceback. Missing proof is infrastructure failure.
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - INFO - >>>>> Patch Apply Failed:\r?$/m.test(log.toString('utf8')),
      'SWE-bench error has no proven patch-application failure');
    return { passed: false, reason: 'patch-application-failed' };
  }
  if (patch === '') {
    assert(has('empty_patch') && !['completed', 'resolved', 'unresolved'].some(has), 'SWE-bench empty-patch report is inconsistent');
    return { passed: false };
  }
  assert(!has('empty_patch') && has('completed') && has('resolved') !== has('unresolved'), 'SWE-bench report is incomplete or ambiguous');
  return { passed: has('resolved') };
}

/** Grade one caller-supplied patch with the pinned official harness; no inference is performed. */
export async function evaluateSWE(options: SWEHarnessOptions, input: SWEEvaluationInput): Promise<SWEEvaluationResult> {
  const config = configuration(options);
  assert(record(input) && typeof input.patch === 'string', 'SWE-bench patch must be a string');
  const selection = { datasetFile: input.datasetFile, datasetSha256: input.datasetSha256, split: input.split, instanceIds: [input.instanceId] };
  const bytes = await sourceBytes(selection), runId = input.runId ?? randomUUID();
  assert(typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) && !runId.includes('..'), 'Unsafe SWE-bench run ID');
  const directory = await claimEvidence(config, runId), snapshot = join(directory, snapshotName(bytes));
  const predictions = join(directory, 'predictions.json'), officialReport = join(config.cwd, 'logs', 'evaluation', runId, 'results.json');
  const predictionBytes = Buffer.from(JSON.stringify([{ instance_id: input.instanceId, model_patch: input.patch, model_name_or_path: 'evopt' }]) + '\n');
  const predictionsSha256 = sha256(predictionBytes);
  const report = join(directory, 'official-report.json');
  let output = { stdout: '', stderr: '' }, preflightOutput = { stdout: '', stderr: '' }, failure: unknown, passed: boolean | undefined, reportBytes: Buffer | undefined;
  let reason: 'patch-application-failed' | undefined, instanceLogSha256: string | undefined, observedPredictionsSha256: string | undefined;
  let stage = 'setup', ownsLogDirectory = false;
  try {
    await verifyHarness(config, 'swebench');
    const logRoot = join(config.cwd, 'logs', 'evaluation');
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    assert(inside(await realpath(config.cwd), await realpath(logRoot)), 'SWE-bench log directory escapes the checkout');
    try { await mkdir(join(logRoot, runId), { mode: 0o700 }); ownsLogDirectory = true; }
    catch (error) { throw new Error('SWE-bench log run ID already exists; refusing stale cached scores', { cause: error }); }
    await writeFile(snapshot, bytes, privateFile);
    await writeFile(predictions, predictionBytes, privateFile);
    stage = 'preflight';
    preflightOutput = await preflight(config, selection, snapshot);
    stage = 'grading';
    output = await runProcess(config.python, ['-X', 'utf8', '-m', 'swebench.harness.run_evaluation',
      '--dataset_name', snapshot, '--split', input.split, '--predictions_path', predictions, '--run_id', runId,
      '--max_workers', '1', '--instance_ids', input.instanceId, '--timeout', String(config.instanceTimeoutSeconds ?? 1800)],
    { cwd: config.cwd, timeoutMs: config.timeoutMs ?? 3_600_000, maxBytes: 32 * 1024 * 1024 });
    await verifyHarness(config, 'swebench');
    assert(sha256(await readFile(snapshot)) === input.datasetSha256, 'SWE-bench dataset snapshot changed during grading');
  } catch (error) {
    failure = error;
    if (error instanceof ProcessFailure) { if (stage === 'preflight') preflightOutput = error; else output = error; }
  }
  if (stage === 'grading') try {
    const observed = await readFile(predictions);
    observedPredictionsSha256 = sha256(observed);
    assert(observed.equals(predictionBytes), 'SWE-bench predictions artifact changed during grading');
  } catch (error) { failure ??= error; }
  // Even a failing subprocess can have written a useful partial report. Preserve it before parsing.
  if (ownsLogDirectory) try {
    const info = await lstat(officialReport);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, 'SWE-bench report is not a bounded regular file');
    reportBytes = await readFile(officialReport);
    await writeFile(report, reportBytes, privateFile);
    if (!failure) {
      const outcome = await parseReport(reportBytes, input.instanceId, input.patch, async () => {
        const runDirectory = join(config.cwd, 'logs', 'evaluation', runId);
        const logFile = join(runDirectory, 'evopt', input.instanceId, 'run_instance.log');
        const info = await lstat(logFile);
        assert(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024
          && inside(await realpath(runDirectory), await realpath(logFile)), 'SWE-bench patch-failure log is not a bounded regular file');
        const log = await readFile(logFile);
        assert(log.length <= 8 * 1024 * 1024, 'SWE-bench patch-failure log exceeded its bound');
        await writeFile(join(directory, 'run_instance.log'), log, privateFile);
        instanceLogSha256 = sha256(log);
        return log;
      });
      passed = outcome.passed; reason = outcome.reason;
    }
  } catch (error) { failure ??= error; }
  await diagnostics(directory, preflightOutput, 'preflight-');
  await diagnostics(directory, output);
  const reportSha256 = reportBytes ? sha256(reportBytes) : undefined;
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ format: 1, benchmark: 'swe-bench', runId,
    status: failure ? 'infrastructure-failed' : 'completed', evaluatorRevision: config.revision, datasetSha256: input.datasetSha256,
    split: input.split, instanceId: input.instanceId, patchSha256: sha256(input.patch), predictionsSha256, observedPredictionsSha256,
    reportSha256, instanceLogSha256, passed, reason, inferenceRun: false,
    error: failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure) }, null, 2) + '\n', privateFile);
  if (failure) throw new Error(`SWE-bench evaluation failed (evidence: ${directory}): ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
  return { passed: passed!, runId, report, reportSha256: reportSha256! };
}
