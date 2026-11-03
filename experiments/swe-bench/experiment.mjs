// Compatibility entry point. The SWE CLI accepts the same config path directly.
import { isAbsolute } from 'node:path';
import { loadSWEExperiment } from 'evopt';

const settingsPath = process.env.EVOPT_SWE_CONFIG;
if (typeof settingsPath !== 'string' || !isAbsolute(settingsPath)) {
  throw new Error('Set EVOPT_SWE_CONFIG to an absolute path to your reviewed private configuration JSON');
}

export default await loadSWEExperiment(settingsPath);
