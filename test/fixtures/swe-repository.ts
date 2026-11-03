import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** Synthetic local Git history and labeled rows; never official benchmark evidence. */
export async function createSWERepositoryFixture(root: string) {
  const repositoryRoot = join(root, 'repositories'), repository = join(repositoryRoot, 'fixture__project');
  await mkdir(repository, { recursive: true });
  const git = (args: string[]) => exec('git', ['-C', repository, '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args]);
  const name = (await exec('git', ['config', 'user.name'])).stdout.trim();
  const email = (await exec('git', ['config', 'user.email'])).stdout.trim();
  if (!name || !email) throw new Error('Configure your Git identity before running repository fixture tests');
  await git(['init', '--quiet', '--template=']);
  await writeFile(join(repository, 'main.txt'), 'baseline\n');
  await git(['add', '--', 'main.txt']);
  await git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-gpg-sign', '--quiet', '-m', 'Add local SWE benchmark fixture']);
  const baseCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(repository, 'solution.txt'), 'future fixture solution, absent from evaluation base\n');
  await git(['add', '--', 'solution.txt']);
  await git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-gpg-sign', '--quiet', '-m', 'Add future fixture change']);
  const futureCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const rows = [1, 2, 3].map(number => ({ instance_id: `fixture__project-${number}`, repo: 'fixture/project', base_commit: baseCommit,
    problem_statement: `Fix fixture issue ${number}`, patch: `hidden-gold-patch-${number}`, test_patch: `hidden-test-patch-${number}`,
    hints_text: `hidden-hint-${number}`, FAIL_TO_PASS: '["hidden-failing-test"]', PASS_TO_PASS: '["hidden-passing-test"]',
    version: 'fixture', image: 'evopt-fixture:local' }));
  const sourceFile = join(root, 'source.json'), body = JSON.stringify(rows);
  await writeFile(sourceFile, body);
  return { repositoryRoot, repository, baseCommit, futureCommit, rows, sourceFile,
    sourceSha256: createHash('sha256').update(body).digest('hex'), sourceRevision: 'a'.repeat(40),
    dataset: 'SWE-bench/SWE-bench_Lite', sourceSplit: 'test',
    groups: { train: [rows[0]!.instance_id], validation: [rows[1]!.instance_id], test: [rows[2]!.instance_id] } };
}
