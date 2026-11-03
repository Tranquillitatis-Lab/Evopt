import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { assertSWESourceMatches, prepareSWE, validateSWEManifest, type PrepareSWEOptions, type SWEInput } from '../benchmarks/import-swe.js';
import { collectSWEPatch, createSWEAgent, verifySWERepositories } from '../benchmarks/swe-workspace.js';
import type { Proposer, RunContext } from '../src/types.js';
import { createSWERepositoryFixture } from './fixtures/swe-repository.js';

const exec = promisify(execFile);
const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
async function temp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'evopt-swe-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const rows = [1, 2, 3].map(n => ({ instance_id: `owner__project-${n}`, repo: 'owner/project', base_commit: 'b'.repeat(40),
  problem_statement: `Problem ${n}`, patch: 'hidden gold', test_patch: 'hidden test', hints_text: 'hidden hints', FAIL_TO_PASS: 'hidden fail', PASS_TO_PASS: 'hidden pass' }));
async function source(root: string, value: unknown[] = rows, jsonl = false): Promise<PrepareSWEOptions> {
  const sourceFile = join(root, jsonl ? 'source.jsonl' : 'source.json');
  const body = jsonl ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(value);
  await writeFile(sourceFile, body);
  return { sourceFile, sourceSha256: sha256(body), sourceRevision: 'a'.repeat(40), dataset: 'SWE-bench/SWE-bench_Verified', sourceSplit: 'test', repositoryRoot: join(root, 'repositories'),
    groups: { train: ['owner__project-1'], validation: ['owner__project-2'], test: ['owner__project-3'] } };
}

test('SWE importer pins local JSON/JSONL and projects only public task fields into explicit partitions', async t => {
  const root = await temp(t);
  for (const jsonl of [false, true]) {
    const options = await source(root, rows, jsonl), manifest = await prepareSWE(options);
    assert.equal(manifest.id, 'swe-bench'); assert.equal(manifest.metric, 'resolved');
    assert.equal(manifest.source.sha256, options.sourceSha256); assert.equal(manifest.source.split, 'test');
    assert.deepEqual(manifest.partitions.train[0], { id: rows[0]!.instance_id, expected: rows[0]!.instance_id,
      input: { instanceId: rows[0]!.instance_id, repo: 'owner/project', baseCommit: 'b'.repeat(40), problemStatement: 'Problem 1', repository: join(root, 'repositories', 'owner__project') } });
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes('hidden')); assert.ok(!serialized.includes(options.sourceFile));
    for (const key of ['patch', 'test_patch', 'hints_text', 'FAIL_TO_PASS', 'PASS_TO_PASS']) assert.ok(!serialized.includes(`"${key}"`));
    await assertSWESourceMatches(manifest, options.sourceFile);
  }
});

test('SWE importer refuses unsupported variants, bad pins, unsafe paths, malformed rows, and overlapping groups', async t => {
  const root = await temp(t), options = await source(root);
  await assert.rejects(prepareSWE({ ...options, sourceSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  await assert.rejects(prepareSWE({ ...options, sourceRevision: 'main' }), /full dataset Git revision/);
  await assert.rejects(prepareSWE({ ...options, dataset: 'SWE-bench/SWE-bench_Multimodal' }), /Only official/);
  await assert.rejects(prepareSWE({ ...options, dataset: 'ScaleAI/SWE-bench_Pro' }), /Only official/);
  await assert.rejects(prepareSWE({ ...options, sourceSplit: 'all' }), /official source split/);
  await assert.rejects(prepareSWE({ ...options, repositoryRoot: '../repositories' }), /absolute local repository root/);
  await assert.rejects(prepareSWE({ ...options, groups: { ...options.groups, test: options.groups.train } }), /Overlapping/);
  await assert.rejects(prepareSWE({ ...options, groups: { ...options.groups, test: ['missing'] } }), /Missing SWE-bench instance/);
  await assert.rejects(prepareSWE({ ...options, groups: { ...options.groups, test: [] } }), /nonempty/);
  await assert.rejects(prepareSWE(await source(root, [rows[0], rows[0], rows[2]])), /Duplicate SWE-bench source/);
  await assert.rejects(prepareSWE(await source(root, [{ ...rows[0], repo: '../escape' }, rows[1], rows[2]])), /Unsafe/);
  await assert.rejects(prepareSWE(await source(root, [{ ...rows[0], base_commit: 'HEAD' }, rows[1], rows[2]])), /base commit/);
  await assert.rejects(prepareSWE(await source(root, [{ ...rows[0], problem_statement: '' }, rows[1], rows[2]])), /nonempty/);
});

test('SWE source binding rejects modified bytes, tasks, labels, and added hidden fields', async t => {
  const root = await temp(t), options = await source(root), manifest = await prepareSWE(options);
  const changed = structuredClone(manifest); changed.partitions.test[0]!.input.problemStatement = 'Altered question';
  await assert.rejects(assertSWESourceMatches(changed, options.sourceFile), /does not match pinned source/);
  const label = structuredClone(manifest); label.partitions.test[0]!.expected = 'hidden gold';
  assert.throws(() => validateSWEManifest(label), /identity and expected label/);
  const hidden = structuredClone(manifest) as unknown as { partitions: { test: { input: Record<string, unknown> }[] } };
  hidden.partitions.test[0]!.input.patch = 'hidden gold';
  assert.throws(() => validateSWEManifest(hidden), /Unexpected or missing/);
  await writeFile(options.sourceFile, JSON.stringify(rows) + '\n');
  await assert.rejects(assertSWESourceMatches(manifest, options.sourceFile), /SHA-256 mismatch/);
});

const proposer: Proposer<SWEInput, string> = { id: 'fixture', version: '1', accounting: { kind: 'free', timeoutMs: 30_000 },
  async propose() { return { output: { systemPrompt: 'fixture' }, usage: { complete: true, receipts: [] } }; } };
const agentSettings = { id: 'swe-fixture', version: '1', components: { systemPrompt: 'Solve the issue' },
  mutable: { systemPrompt: { role: 'task instructions', maxLength: 200 } }, accounting: { kind: 'free' as const, timeoutMs: 30_000 }, optimization: { proposer } };

test('SWE wrapper gives every invocation an exact isolated base with no future commits and preserves source state', async t => {
  const root = await temp(t), fixture = await createSWERepositoryFixture(root), manifest = await prepareSWE(fixture);
  await verifySWERepositories(manifest);
  const input = manifest.partitions.train[0]!.input, workspaces: string[] = [];
  const contexts: RunContext[] = [];
  const agent = createSWEAgent({ ...agentSettings, workspaceRoot: join(root, 'workspaces'), async run(args) {
    contexts.push(args.context); workspaces.push(args.workspace);
    assert.deepEqual(args.input, input); assert.equal(args.components, agentSettings.components);
    assert.equal((await exec('git', ['-C', args.workspace, 'rev-parse', 'HEAD'])).stdout.trim(), fixture.baseCommit);
    assert.equal((await exec('git', ['-C', args.workspace, 'rev-list', '--all'])).stdout.trim(), fixture.baseCommit);
    assert.equal((await exec('git', ['-C', args.workspace, 'remote'])).stdout, '');
    await assert.rejects(exec('git', ['-C', args.workspace, 'cat-file', '-e', fixture.futureCommit]));
    await assert.rejects(access(join(args.workspace, 'solution.txt')));
    assert.equal(await readFile(join(args.workspace, 'main.txt'), 'utf8'), 'baseline\n');
    await writeFile(join(args.workspace, 'main.txt'), 'fixture-pass\n');
    await writeFile(join(args.workspace, 'new.txt'), 'new fixture file\n');
    await writeFile(join(args.workspace, 'binary.bin'), Buffer.from([0, 1, 2, 0, 4]));
    const patch = await collectSWEPatch(args.workspace, args.input.baseCommit);
    const name = (await exec('git', ['config', 'user.name'])).stdout.trim();
    const email = (await exec('git', ['config', 'user.email'])).stdout.trim();
    await exec('git', ['-C', args.workspace, '-c', 'core.hooksPath=', '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-gpg-sign', '--quiet', '-m', 'Save local fixture changes']);
    assert.equal(await collectSWEPatch(args.workspace), patch, 'Patch must retain edits committed by the existing agent');
    return { output: patch, usage: { complete: true, receipts: [] } };
  } });
  const firstContext = { signal: new AbortController().signal, evaluationId: 'first' };
  const secondContext = { signal: new AbortController().signal, evaluationId: 'second' };
  const first = await agent.run({ input, components: agent.components, context: firstContext });
  const second = await agent.run({ input, components: agent.components, context: secondContext });
  assert.notEqual(workspaces[0], workspaces[1]); assert.deepEqual(contexts, [firstContext, secondContext]);
  assert.equal(contexts[0], firstContext); assert.equal(contexts[1], secondContext);
  assert.match(first.output, /fixture-pass/); assert.match(first.output, /new file mode/); assert.match(first.output, /GIT binary patch/);
  assert.equal(first.output, second.output);
  for (const workspace of workspaces) {
    for (const name of await readdir(join(workspace, '.git', 'objects'), { recursive: true })) {
      const file = await stat(join(workspace, '.git', 'objects', name)); if (file.isFile()) assert.equal(file.nlink, 1);
    }
  }
  assert.equal(await readFile(join(fixture.repository, 'main.txt'), 'utf8'), 'baseline\n');
  assert.equal((await exec('git', ['-C', fixture.repository, 'status', '--porcelain'])).stdout, '');
  assert.equal((await exec('git', ['-C', fixture.repository, 'rev-parse', 'HEAD'])).stdout.trim(), fixture.futureCommit);
});

test('SWE wrapper rejects missing bases and source-contained workspaces, and respects pre-aborted contexts', async t => {
  const root = await temp(t), fixture = await createSWERepositoryFixture(root), manifest = await prepareSWE(fixture);
  const missing = structuredClone(manifest); missing.partitions.test[0]!.input.baseCommit = 'f'.repeat(40);
  await assert.rejects(verifySWERepositories(missing), /process failed/);
  let calls = 0;
  const callback = async () => { calls++; return { output: '', usage: { complete: true as const, receipts: [] } }; };
  const agent = createSWEAgent({ ...agentSettings, workspaceRoot: join(root, 'workspaces'), run: callback });
  const controller = new AbortController(); controller.abort(new Error('fixture abort'));
  await assert.rejects(agent.run({ input: manifest.partitions.train[0]!.input, components: agent.components, context: { signal: controller.signal, evaluationId: 'aborted' } }), /fixture abort/);
  assert.equal(calls, 0); await assert.rejects(access(join(root, 'workspaces')));
  const unsafe = createSWEAgent({ ...agentSettings, workspaceRoot: join(fixture.repository, 'workspaces'), run: callback });
  await assert.rejects(unsafe.run({ input: manifest.partitions.train[0]!.input, components: unsafe.components, context: { signal: new AbortController().signal, evaluationId: 'unsafe' } }), /outside their source repository/);
  assert.equal(calls, 0); await assert.rejects(access(join(fixture.repository, 'workspaces')));
});
