import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessFailure, runProcess, verifyHarness } from '../benchmarks/harness.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'evopt-harness-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, timeoutMs: 10_000 };
  await runProcess('git', ['init', '--quiet'], options);
  await mkdir(join(cwd, 'swebench'));
  await writeFile(join(cwd, 'swebench', 'evaluation_main.py'), '# Reviewed local test fixture\n');
  await writeFile(join(cwd, '.gitignore'), '__pycache__/\nignored/\n');
  await runProcess('git', ['add', '.gitignore', 'swebench'], options);
  const identityOptions = { cwd: process.cwd(), timeoutMs: 10_000 };
  const name = (await runProcess('git', ['config', '--get', 'user.name'], identityOptions)).stdout.trim();
  const email = (await runProcess('git', ['config', '--get', 'user.email'], identityOptions)).stdout.trim();
  await runProcess('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add evaluator fixture'], options);
  const revision = (await runProcess('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  return { cwd, python: process.execPath, revision, timeoutMs: 10_000 };
}

test('harness verifies exact checkout and clean evaluator while allowing ordinary Python caches', async t => {
  const pin = await fixture(t);
  assert.deepEqual(await verifyHarness(pin), { revision: pin.revision });
  await mkdir(join(pin.cwd, 'swebench', '__pycache__'));
  await writeFile(join(pin.cwd, 'swebench', '__pycache__', 'evaluation_main.cpython-311.pyc'), 'cache fixture');
  assert.deepEqual(await verifyHarness(pin), { revision: pin.revision });
  // Unrelated private notes outside the evaluator package are not executable imports.
  await writeFile(join(pin.cwd, 'notes.txt'), 'private local notes');
  await verifyHarness(pin);
});

test('harness rejects revision mismatch, modified source, and unsafe setup', async t => {
  const pin = await fixture(t);
  await assert.rejects(verifyHarness({ ...pin, revision: '0'.repeat(40) }), /pinned revision/);
  await assert.rejects(verifyHarness({ ...pin, revision: 'main' }), /exact evaluator Git commit/);
  await assert.rejects(verifyHarness({ ...pin, python: 'python' }), /absolute Python/);
  await assert.rejects(verifyHarness(pin, '../other'), /Unsafe evaluator/);
  await appendFile(join(pin.cwd, 'swebench', 'evaluation_main.py'), '# modified\n');
  await assert.rejects(verifyHarness(pin), /unmodified/);
});

test('harness rejects untracked and ignored importable evaluator source', async t => {
  const pin = await fixture(t), loose = join(pin.cwd, 'swebench', 'unexpected.py');
  await writeFile(loose, '# unexpected\n');
  await assert.rejects(verifyHarness(pin), /Untracked evaluator/);
  await rm(loose);
  await mkdir(join(pin.cwd, 'swebench', 'ignored'));
  await writeFile(join(pin.cwd, 'swebench', 'ignored', 'unexpected.py'), '# ignored\n');
  await assert.rejects(verifyHarness(pin), /Ignored evaluator source/);
});

test('fixed argv does not evaluate shell syntax and captures bounded process output', async t => {
  const pin = await fixture(t);
  const argument = 'a; echo injected && $(ignored)';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("diagnostic")', argument], { cwd: pin.cwd, timeoutMs: 5000 });
  assert.equal(result.stdout, argument); assert.equal(result.stderr, 'diagnostic');
});

test('process failures, timeout, and excessive output fail closed', async t => {
  const pin = await fixture(t), options = { cwd: pin.cwd, timeoutMs: 5000 };
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("progress"); process.stderr.write("missing resource"); process.exitCode = 7'], options), error => {
    assert.ok(error instanceof ProcessFailure);
    assert.match(error.message, /failed \(7\)/);
    assert.equal(error.stdout, 'progress');
    assert.equal(error.stderr, 'missing resource');
    assert.ok(error.cause instanceof Error);
    return true;
  });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("started"); setInterval(() => {}, 1000)'], { ...options, timeoutMs: 1000 }), error => {
    assert.ok(error instanceof ProcessFailure);
    assert.match(error.message, /timed out/);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'started');
    return true;
  });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { ...options, maxBytes: 128 }), error => {
    assert.ok(error instanceof ProcessFailure);
    assert.match(error.message, /output bound/);
    assert.equal(error.stdout, 'x'.repeat(128));
    assert.equal(error.stderr, '');
    return true;
  });
  await assert.rejects(runProcess(join(pin.cwd, 'missing-executable'), [], options), error => {
    assert.ok(error instanceof ProcessFailure);
    assert.match(error.message, /ENOENT/);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, '');
    return true;
  });
  await assert.rejects(runProcess(process.execPath, [], { ...options, timeoutMs: 0 }), error => {
    assert.ok(error instanceof Error && !(error instanceof ProcessFailure));
    assert.match(error.message, /timeout/);
    return true;
  });
});
