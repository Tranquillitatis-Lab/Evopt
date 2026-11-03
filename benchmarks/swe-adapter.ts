import { resolve } from 'node:path';
import type { Dataset } from '../src/types.js';
import { assert, canonical, clone, hash, record, text } from '../src/validation.js';
import { assertSWESourceMatches, validateSWEManifest, type SWEInput, type SWEManifest } from './import-swe.js';
import { checkSWEHarness, evaluateSWE, type SWEHarnessOptions } from './swe-bench.js';
import { verifySWERepositories } from './swe-workspace.js';

export interface SWEDatasetOptions extends SWEHarnessOptions {
  /** Private complete source export; never passed to the target or proposer. */
  datasetFile: string;
}

/** Bind sanitized SWE tasks to a local pinned official evaluator. No inference is dispatched. */
export async function createSWEDataset(manifest: SWEManifest, options: SWEDatasetOptions): Promise<Dataset<SWEInput, string>> {
  validateSWEManifest(manifest);
  assert(record(options), 'Missing SWE-bench evaluator settings');
  text(options.datasetFile); text(options.cwd); text(options.evidenceDirectory);
  const pinned = clone(manifest);
  const config = { ...options, datasetFile: resolve(options.datasetFile), cwd: resolve(options.cwd), evidenceDirectory: resolve(options.evidenceDirectory) };
  const tasks = [...pinned.partitions.train, ...pinned.partitions.validation, ...pinned.partitions.test];
  const byId = new Map(tasks.map(task => [task.id, task]));
  await assertSWESourceMatches(pinned, config.datasetFile);
  await verifySWERepositories(pinned);
  await checkSWEHarness(config, { datasetFile: config.datasetFile, datasetSha256: pinned.source.sha256,
    split: pinned.source.split, instanceIds: tasks.map(task => task.id) });
  return {
    id: `${pinned.source.name}:${pinned.source.split}`,
    version: hash({ adapter: 'swe-bench-resolved-v1', manifest: pinned, evaluatorRevision: config.revision,
      instanceTimeoutSeconds: config.instanceTimeoutSeconds ?? 1800, timeoutMs: config.timeoutMs ?? 3_600_000 }),
    benchmark: { id: pinned.source.name, sourceRevision: pinned.source.revision, sourceSha256: pinned.source.sha256,
      manifestSha256: hash(pinned), metric: pinned.metric, splitPolicy: pinned.splitPolicy,
      evaluator: { name: 'swebench.harness.run_evaluation', revision: config.revision } },
    train: clone(pinned.partitions.train), validation: clone(pinned.partitions.validation), test: clone(pinned.partitions.test),
    async score({ input, output, expected }) {
      assert(record(input) && typeof output === 'string' && typeof expected === 'string', 'SWE-bench requires a sanitized task and string patch');
      const task = byId.get(expected);
      assert(task && task.id === input.instanceId && canonical(task.input) === canonical(input), 'SWE-bench scoring request differs from the prepared manifest');
      await assertSWESourceMatches(pinned, config.datasetFile);
      const result = await evaluateSWE(config, { datasetFile: config.datasetFile, datasetSha256: pinned.source.sha256,
        split: pinned.source.split, instanceId: task.id, patch: output });
      return result.passed;
    },
  };
}
