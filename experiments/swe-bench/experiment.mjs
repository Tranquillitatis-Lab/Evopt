// Trusted local experiment: preparation checks infrastructure and makes no inference requests.
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineExperiment } from 'evopt';
import { createSWEDataset, validateSWEManifest } from 'evopt/benchmarks';

const settingsPath = process.env.EVOPT_SWE_CONFIG;
if (typeof settingsPath !== 'string' || !isAbsolute(settingsPath)) {
  throw new Error('Set EVOPT_SWE_CONFIG to an absolute path to your reviewed private configuration JSON');
}
const config = JSON.parse(await readFile(settingsPath, 'utf8'));
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('SWE-bench configuration must be an object');
const root = dirname(settingsPath);
function configuredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing SWE-bench ${name} path`);
  return resolve(root, value);
}
const manifest = JSON.parse(await readFile(configuredPath(config.manifest, 'manifest'), 'utf8'));
validateSWEManifest(manifest);
const harness = config.harness;
if (!harness || typeof harness !== 'object' || Array.isArray(harness)) throw new Error('Missing SWE-bench harness configuration');
if (typeof harness.python !== 'string' || !isAbsolute(harness.python)) throw new Error('SWE-bench python must be an absolute executable path');
const dataset = await createSWEDataset(manifest, {
  datasetFile: configuredPath(config.datasetFile, 'datasetFile'),
  python: harness.python,
  cwd: configuredPath(harness.cwd, 'harness cwd'),
  revision: harness.revision,
  ...(harness.timeoutMs === undefined ? {} : { timeoutMs: harness.timeoutMs }),
  ...(harness.instanceTimeoutSeconds === undefined ? {} : { instanceTimeoutSeconds: harness.instanceTimeoutSeconds }),
  evidenceDirectory: configuredPath(harness.evidenceDirectory, 'evidence directory'),
});

// Explicitly selected existing application code. Imports must not dispatch paid calls.
const { agent } = await import(pathToFileURL(configuredPath(config.agentModule, 'agentModule')).href);
if (!agent) throw new Error('The selected agent module must export a configured named agent');

export default defineExperiment({
  id: `swe-bench-${agent.id}`,
  description: 'SWE-bench issue resolution on an explicitly selected custom disjoint subset; not an official leaderboard result.',
  agent, dataset, objective: 'accuracy',
});
