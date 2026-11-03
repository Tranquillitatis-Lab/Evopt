import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSWEHarness, evaluateSWE } from '../benchmarks/swe-bench.js';
import { runProcess } from '../benchmarks/harness.js';
import { createFakeSWEHarness } from './fixtures/swe-harness.js';

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const instanceId = 'fixture__repo-1';
async function fixture(t: TestContext) {
  let python: string;
  try { python = (await runProcess('python', ['-c', 'import sys; print(sys.executable)'], { cwd: process.cwd(), timeoutMs: 10_000 })).stdout.trim(); }
  catch { t.skip('Python is required for offline SWE-bench subprocess fixtures'); return; }
  const root = await mkdtemp(join(tmpdir(), 'evopt-swe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createFakeSWEHarness(root, python);
  const options = { ...harness, evidenceDirectory: join(root, 'evidence'), timeoutMs: 10_000, instanceTimeoutSeconds: 37 };
  const bytes = JSON.stringify([{ instance_id: instanceId, problem_statement: 'Fixture issue', image: 'evopt-fixture:local' }]) + '\n';
  const datasetFile = join(root, 'source.json'); await writeFile(datasetFile, bytes);
  const input = { datasetFile, datasetSha256: sha256(bytes), split: 'test', instanceId };
  const selection = { datasetFile, datasetSha256: input.datasetSha256, split: 'test', instanceIds: [instanceId] };
  return { root, options, bytes, input, selection };
}

test('SWE-bench preflight checks local imports, Docker, selected rows and images without grading', async t => {
  const f = await fixture(t); if (!f) return;
  await checkSWEHarness(f.options);
  await checkSWEHarness(f.options, f.selection);
  await assert.rejects(readdir(join(f.options.cwd, 'logs')), /ENOENT/);
  await writeFile(join(f.options.cwd, '.docker-unavailable'), 'fixture');
  await assert.rejects(checkSWEHarness(f.options, f.selection), /preflight failed/);
  await rm(join(f.options.cwd, '.docker-unavailable'));
  await writeFile(join(f.options.cwd, '.loader-changed'), 'fixture');
  await assert.rejects(checkSWEHarness(f.options, f.selection), /preflight failed/);
  await rm(join(f.options.cwd, '.loader-changed'));
  const unavailable = JSON.stringify([{ instance_id: instanceId, image: 'fixture:missing' }]);
  await writeFile(f.input.datasetFile, unavailable);
  await assert.rejects(checkSWEHarness(f.options, { ...f.selection, datasetSha256: sha256(unavailable) }), /preflight failed/);
  const paths = await readdir(f.options.evidenceDirectory);
  assert.equal(paths.length, 5);
  const receipts = await Promise.all(paths.map(async path => JSON.parse(await readFile(join(f.options.evidenceDirectory, path, 'receipt.json'), 'utf8'))));
  assert.equal(receipts.filter(receipt => receipt.status === 'completed').length, 2);
  assert.ok(receipts.every(receipt => receipt.inferenceRun === false));
  const diagnostics = await Promise.all(paths.map(path => readFile(join(f.options.evidenceDirectory, path, 'stderr.txt'), 'utf8')));
  assert.ok(diagnostics.some(value => value.includes('Docker daemon unavailable')));
  assert.ok(diagnostics.some(value => value.includes('loader changed a selected row')));
  assert.ok(diagnostics.some(value => value.includes('local image unavailable')));
});

test('SWE-bench grades one exact local selection and preserves reports for pass, fail, and empty patch', async t => {
  const f = await fixture(t); if (!f) return;
  const patch = 'fixture-pass café ; echo literal';
  const result = await evaluateSWE(f.options, { ...f.input, patch });
  assert.equal(result.passed, true); assert.match(result.runId, /^[a-f0-9-]{36}$/);
  const directory = join(f.options.evidenceDirectory, result.runId);
  assert.equal(await readFile(join(directory, 'dataset.json'), 'utf8'), f.bytes);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'predictions.json'), 'utf8')), [{ instance_id: instanceId, model_patch: patch, model_name_or_path: 'evopt' }]);
  assert.equal(sha256(await readFile(result.report)), result.reportSha256);
  const args = JSON.parse(await readFile(join(f.options.cwd, 'logs', 'evaluation', result.runId, 'args.json'), 'utf8'));
  assert.equal(args.dataset_name, join(directory, 'dataset.json'));
  assert.equal(args.instance_ids, instanceId); assert.equal(args.max_workers, '1'); assert.equal(args.timeout, '37'); assert.equal(args.utf8_mode, 1);
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.patchSha256, sha256(patch)); assert.equal(receipt.reportSha256, result.reportSha256);
  assert.equal(receipt.predictionsSha256, sha256(await readFile(join(directory, 'predictions.json'))));
  assert.equal(receipt.observedPredictionsSha256, receipt.predictionsSha256);
  assert.equal((await evaluateSWE(f.options, { ...f.input, patch: 'fail' })).passed, false);
  assert.equal((await evaluateSWE(f.options, { ...f.input, patch: '' })).passed, false);
  await assert.rejects(evaluateSWE(f.options, { ...f.input, patch: 'pass', runId: result.runId }), /refusing reuse/);
  assert.equal(sha256(await readFile(result.report)), result.reportSha256);
});

test('SWE-bench scores only proven patch-application failures as false and binds prediction artifacts', async t => {
  const f = await fixture(t); if (!f) return;
  const result = await evaluateSWE(f.options, { ...f.input, patch: 'bad-patch' });
  assert.equal(result.passed, false);
  const directory = join(f.options.evidenceDirectory, result.runId);
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.reason, 'patch-application-failed');
  assert.equal(receipt.instanceLogSha256, sha256(await readFile(join(directory, 'run_instance.log'))));
  assert.equal(receipt.predictionsSha256, sha256(await readFile(join(directory, 'predictions.json'))));
  const report = JSON.parse(await readFile(result.report, 'utf8'));
  assert.deepEqual(report.error_ids, [instanceId]); assert.deepEqual(report.completed_ids, []);
  assert.equal(sha256(await readFile(result.report)), sha256(await readFile(join(f.options.cwd, 'logs', 'evaluation', result.runId, 'results.json'))));
  for (const patch of ['bad-patch-infra', 'bad-patch-ambiguous', 'bad-patch-inconsistent', 'bad-patch-markerless', 'bad-patch-loose-marker', 'bad-patch-oversized', 'predictions-mutate']) {
    await assert.rejects(evaluateSWE(f.options, { ...f.input, patch, runId: patch }), /SWE-bench evaluation failed/);
    const failed = JSON.parse(await readFile(join(f.options.evidenceDirectory, patch, 'receipt.json'), 'utf8'));
    assert.equal(failed.status, 'infrastructure-failed'); assert.equal(failed.passed, undefined); assert.equal(failed.reason, undefined);
    if (patch === 'predictions-mutate') {
      assert.match(failed.error, /predictions artifact changed/);
      assert.notEqual(failed.predictionsSha256, failed.observedPredictionsSha256);
    }
  }
});

test('SWE-bench preserves local JSONL snapshot bytes and invokes the matching official loader format', async t => {
  const f = await fixture(t); if (!f) return;
  const rows = [instanceId, 'fixture__repo-2'].map(id => ({ instance_id: id, problem_statement: 'Unicode café', image: 'evopt-fixture:local' }));
  const bytes = rows.map(row => JSON.stringify(row)).join('\r\n') + '\r\n';
  const datasetFile = join(f.root, 'source.jsonl'); await writeFile(datasetFile, bytes);
  const datasetSha256 = sha256(bytes);
  await checkSWEHarness(f.options, { ...f.selection, datasetFile, datasetSha256, instanceIds: rows.map(row => row.instance_id) });
  const result = await evaluateSWE(f.options, { ...f.input, datasetFile, datasetSha256, patch: 'pass' });
  assert.equal(result.passed, true);
  assert.equal(await readFile(join(f.options.evidenceDirectory, result.runId, 'dataset.jsonl'), 'utf8'), bytes);
  const args = JSON.parse(await readFile(join(f.options.cwd, 'logs', 'evaluation', result.runId, 'args.json'), 'utf8'));
  assert.match(args.dataset_name, /dataset\.jsonl$/);
});

test('SWE-bench separates incomplete, ambiguous, infrastructure and process failures from failed answers', async t => {
  const f = await fixture(t); if (!f) return;
  for (const patch of ['infra', 'ambiguous', 'error', 'wrong-id', 'both', 'missing-completion', 'wrong-count', 'missing', 'crash', 'mutate']) {
    const runId = `fixture-${patch}`;
    await assert.rejects(evaluateSWE(f.options, { ...f.input, patch, runId }), /SWE-bench evaluation failed/);
    const directory = join(f.options.evidenceDirectory, runId);
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'infrastructure-failed', patch); assert.equal(receipt.passed, undefined);
    assert.match(await readFile(join(directory, 'stdout.txt'), 'utf8'), /^fixture grading stdout\r?\n$/);
    assert.match(await readFile(join(directory, 'stderr.txt'), 'utf8'), /fixture grading stderr/);
    if (patch !== 'missing') {
      assert.equal(sha256(await readFile(join(directory, 'official-report.json'))), receipt.reportSha256);
    }
  }
  assert.match(await readFile(join(f.options.evidenceDirectory, 'fixture-crash', 'stderr.txt'), 'utf8'), /subprocess crashed/);
});

test('SWE-bench rejects byte mismatch, malformed selections, changed pins and cached log IDs before grading', async t => {
  const f = await fixture(t); if (!f) return;
  await assert.rejects(evaluateSWE(f.options, { ...f.input, datasetSha256: '0'.repeat(64), patch: 'pass' }), /SHA-256 mismatch/);
  await assert.rejects(evaluateSWE(f.options, { ...f.input, instanceId: 'bad/id', patch: 'pass' }), /instance IDs/);
  await assert.rejects(evaluateSWE(f.options, { ...f.input, instanceId: 'missing__repo-1', patch: 'pass' }), /missing from/);
  await assert.rejects(evaluateSWE(f.options, { ...f.input, patch: 'pass', runId: '../escape' }), /Unsafe/);
  await assert.rejects(checkSWEHarness({ ...f.options, evidenceDirectory: join(f.options.cwd, 'private') }), /outside/);
  await assert.rejects(readdir(f.options.evidenceDirectory), /ENOENT/);
  const log = join(f.options.cwd, 'logs', 'evaluation', 'already-used');
  await mkdir(log, { recursive: true }); await writeFile(join(log, 'results.json'), '{"stale":true}');
  await assert.rejects(evaluateSWE(f.options, { ...f.input, patch: 'pass', runId: 'already-used' }), /stale cached scores/);
  assert.equal(await readFile(join(log, 'results.json'), 'utf8'), '{"stale":true}');
  await assert.rejects(checkSWEHarness({ ...f.options, revision: '0'.repeat(40) }), /pinned revision/);
  await writeFile(join(f.options.cwd, 'swebench', 'harness', '__init__.py'), '# changed');
  await assert.rejects(evaluateSWE(f.options, { ...f.input, patch: 'pass', runId: 'changed' }), /unmodified/);
  await assert.rejects(readFile(join(f.options.cwd, 'logs', 'evaluation', 'changed', 'args.json')), /ENOENT/);
});
