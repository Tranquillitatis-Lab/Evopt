import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execute } from './process.ts';

export interface SWEHarnessOptions { python: string; harnessCwd: string; revision: string; timeoutMs?: number }
export interface SWEEvaluation { predictions: string; dataset: string; split: string; instanceIds: string[]; runId: string; outDir: string }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Check the local evaluator before any agent invocation and before each grading call. */
export async function checkSWEHarness(config: SWEHarnessOptions) {
  if (!config.python || !config.harnessCwd || !/^[a-f0-9]{40}$/.test(config.revision)) throw new Error('Pin Python, harness checkout, and full harness commit');
  const actual = await execute('git', ['-C', config.harnessCwd, 'rev-parse', 'HEAD'], { timeoutMs: 10000 });
  if (actual.stdout.trim() !== config.revision) throw new Error('Official harness checkout differs from pinned revision');
  const dirty = await execute('git', ['-C', config.harnessCwd, 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 10000 });
  const unsafe = dirty.stdout.split(/\r?\n/).filter(line => line && !/__(?:pycache)__|\.pyc$|^\?\? logs\//.test(line));
  if (unsafe.length) throw new Error('Official harness checkout must be clean');
  await execute(config.python, ['-c', "import importlib.util; assert importlib.util.find_spec('swebench.harness.run_evaluation') is not None"], { cwd: config.harnessCwd, timeoutMs: 10000 });
}

/** Run the pinned official local evaluator on explicitly prepared predictions. */
export async function evaluateSWE(config: SWEHarnessOptions, input: SWEEvaluation) {
  await checkSWEHarness(config);
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId) || !input.instanceIds.length || input.instanceIds.some(id => !/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(id))) throw new Error('Invalid evaluator run or instance id');
  const report = join(config.harnessCwd, 'logs', 'evaluation', input.runId, 'results.json');
  try { await stat(join(config.harnessCwd, 'logs', 'evaluation', input.runId)); throw new Error('SWE-bench run id already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(input.outDir, { recursive: true });
  const result = await execute(config.python, ['-m', 'swebench.harness.run_evaluation', '--dataset_name', input.dataset,
    '--split', input.split, '--predictions_path', input.predictions, '--run_id', input.runId, '--max_workers', '1', '--instance_ids', ...input.instanceIds],
  { cwd: config.harnessCwd, timeoutMs: config.timeoutMs ?? 3600000, maxBytes: 32 * 1024 * 1024 });
  const reportText = await readFile(report, 'utf8'), parsed: unknown = JSON.parse(reportText);
  await writeFile(join(input.outDir, 'official-report.json'), reportText, { flag: 'wx', mode: 0o600 });
  return { runId: input.runId, report: join(input.outDir, 'official-report.json'), reportHash: sha256(reportText), stdoutHash: sha256(result.stdout), result: parsed };
}
