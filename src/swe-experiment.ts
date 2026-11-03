import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSWEDataset } from '../benchmarks/swe-adapter.js';
import { validateSWEManifest, type SWEInput } from '../benchmarks/import-swe.js';
import { defineExperiment, type Experiment } from './experiments.js';
import { assert, integer, record, text, validateAgent } from './validation.js';
import type { Agent } from './types.js';

/** Paths are relative to this JSON file, except the explicitly absolute interpreter. */
export interface SWEExperimentConfig {
  version?: 1;
  agentModule: string; manifest: string; datasetFile: string;
  harness: { python: string; cwd: string; revision: string; evidenceDirectory: string; timeoutMs?: number; instanceTimeoutSeconds?: number };
}

function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  assert(record(value), 'SWE configuration must contain plain objects');
  assert(required.every(key => Object.hasOwn(value, key)), `SWE configuration requires ${required.join(', ')}`);
  assert(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unsupported SWE configuration field');
}
function configuredPath(root: string, value: unknown, name: string): string {
  text(value); assert(!/[<>]/.test(value), `Replace the SWE ${name} placeholder`); return resolve(root, value);
}
async function regularFile(path: string, name: string): Promise<void> {
  assert((await stat(path)).isFile(), `SWE ${name} must be a regular file`);
}

/**
 * Load an explicitly selected trusted agent only after local benchmark preflight.
 * No environment configuration, downloads, provisioning or inference is performed.
 * Application modules must not run inference as an import side effect.
 */
export async function loadSWEExperiment(configPath: string): Promise<Experiment<SWEInput, string>> {
  text(configPath); const path = resolve(configPath), root = dirname(path);
  const file = await stat(path); assert(file.isFile() && file.size <= 1024 * 1024, 'SWE configuration must be a JSON file of at most 1 MiB');
  const config: unknown = JSON.parse(await readFile(path, 'utf8'));
  fields(config, ['agentModule', 'manifest', 'datasetFile', 'harness'], ['version']);
  assert(config.version === undefined || config.version === 1, 'Unsupported SWE configuration version');
  const harness = config.harness;
  fields(harness, ['python', 'cwd', 'revision', 'evidenceDirectory'], ['timeoutMs', 'instanceTimeoutSeconds']);
  const agentModule = configuredPath(root, config.agentModule, 'agentModule');
  const manifestFile = configuredPath(root, config.manifest, 'manifest');
  const datasetFile = configuredPath(root, config.datasetFile, 'datasetFile');
  const cwd = configuredPath(root, harness.cwd, 'harness cwd');
  const evidenceDirectory = configuredPath(root, harness.evidenceDirectory, 'evidence directory');
  text(harness.python); assert(isAbsolute(harness.python) && !/[<>]/.test(harness.python), 'SWE python must be an absolute executable path');
  assert(typeof harness.revision === 'string' && /^[a-f0-9]{40}$/.test(harness.revision), 'SWE harness revision must be a full lowercase Git commit');
  const duration = (key: 'timeoutMs' | 'instanceTimeoutSeconds'): number | undefined => {
    const value = harness[key]; if (value === undefined) return undefined;
    integer(value, 1); assert(value <= 2_147_483_647, `SWE ${key} exceeds its limit`); return value;
  };
  const timeoutMs = duration('timeoutMs'), instanceTimeoutSeconds = duration('instanceTimeoutSeconds');
  await regularFile(agentModule, 'agentModule'); await regularFile(manifestFile, 'manifest'); await regularFile(datasetFile, 'datasetFile');
  const manifest: unknown = JSON.parse(await readFile(manifestFile, 'utf8'));
  validateSWEManifest(manifest);
  const dataset = await createSWEDataset(manifest, {
    datasetFile, cwd, evidenceDirectory, python: harness.python, revision: harness.revision,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(instanceTimeoutSeconds === undefined ? {} : { instanceTimeoutSeconds }),
  });
  const module = await import(pathToFileURL(agentModule).href);
  assert(Object.hasOwn(module, 'agent'), 'The SWE agent module must export a configured named agent');
  const agent = module.agent as Agent<SWEInput, string>; validateAgent(agent);
  return defineExperiment({ id: `swe-bench-${agent.id}`, agent, dataset, objective: 'tokens',
    description: 'SWE-bench text optimization on a pinned custom disjoint subset; resolved quality gates token savings. Not an official leaderboard result.' });
}
