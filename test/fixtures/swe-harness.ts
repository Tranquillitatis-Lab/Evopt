import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../../benchmarks/harness.js';

/** Offline protocol fixture only. It is not the official evaluator or benchmark evidence. */
export async function createFakeSWEHarness(root: string, python: string) {
  const cwd = join(root, 'harness'), packageDir = join(cwd, 'swebench', 'harness');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(cwd, 'swebench', '__init__.py'), '');
  await writeFile(join(packageDir, '__init__.py'), '');
  await writeFile(join(cwd, 'docker.py'), `# Offline Docker protocol fixture; never contacts Docker.
from pathlib import Path
class Images:
    def get(self, name):
        if name != 'evopt-fixture:local':
            raise RuntimeError('fixture local image unavailable: ' + name)
        return object()
class Client:
    images = Images()
    def ping(self):
        if Path('.docker-unavailable').exists():
            raise RuntimeError('fixture Docker daemon unavailable')
        return True
    def close(self):
        pass
def from_env():
    return Client()
`);
  await writeFile(join(packageDir, 'utils.py'), `# Offline local loader fixture.
import json
from pathlib import Path
def load_swebench_dataset(name, split, instance_ids):
    text = Path(name).read_text(encoding='utf-8')
    dataset = json.loads(text) if name.endswith('.json') else [json.loads(line) for line in text.splitlines() if line.strip()]
    rows = [row for row in dataset if row['instance_id'] in instance_ids]
    if Path('.loader-changed').exists():
        rows[0]['problem_statement'] = 'changed'
    return rows
`);
  await writeFile(join(packageDir, 'run_evaluation.py'), `# Offline evaluator protocol fixture; never runs containers or inference.
import argparse, json, sys
from pathlib import Path
from types import SimpleNamespace
def make_test_spec(row):
    return SimpleNamespace(image=row['image'], instance_id=row['instance_id'])
def main():
    parser = argparse.ArgumentParser()
    for name in ['dataset_name', 'split', 'predictions_path', 'run_id', 'max_workers', 'instance_ids', 'timeout']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    directory = Path('logs', 'evaluation', args.run_id)
    directory.mkdir(parents=True, exist_ok=True)
    predictions = json.loads(Path(args.predictions_path).read_text(encoding='utf-8'))
    if len(predictions) != 1 or predictions[0]['instance_id'] != args.instance_ids:
        raise RuntimeError('fixture prediction selection mismatch')
    patch = predictions[0]['model_patch']
    id = args.instance_ids
    print('fixture grading stdout')
    print('fixture grading stderr', file=sys.stderr)
    Path(directory, 'args.json').write_text(json.dumps({**vars(args), 'utf8_mode': sys.flags.utf8_mode}), encoding='utf-8')
    resolved = patch == 'pass' or 'fixture-pass' in patch
    report = {'total_instances': 1, 'submitted_ids': [id], 'completed_ids': [id] if patch else [],
        'resolved_ids': [id] if resolved else [], 'unresolved_ids': [id] if patch and not resolved else [],
        'empty_patch_ids': [] if patch else [id], 'error_ids': [], 'incomplete_ids': []}
    if patch == 'infra': report['infra_failure_ids'] = [id]
    if patch == 'ambiguous': report['ambiguous_failure_ids'] = [id]
    if patch == 'error': report['error_ids'] = [id]
    if patch == 'wrong-id': report['submitted_ids'] = ['different__case-1']
    if patch == 'both': report['resolved_ids'] = [id]
    if patch == 'missing-completion': report['completed_ids'] = []
    if patch == 'wrong-count': report['completed_instances'] = 3
    if patch == 'mutate':
        with open(args.dataset_name, 'a', encoding='utf-8') as output: output.write('\\n')
    if patch == 'predictions-mutate':
        with open(args.predictions_path, 'a', encoding='utf-8') as output: output.write('\\n')
    if patch.startswith('bad-patch'):
        report['completed_ids'] = []; report['resolved_ids'] = []; report['unresolved_ids'] = []; report['error_ids'] = [id]
        log = '2026-11-03 12:00:00,123 - INFO - >>>>> Patch Apply Failed:\\nerror: fixture patch does not apply\\n'
        if patch == 'bad-patch-infra': report['infra_failure_ids'] = [id]
        if patch == 'bad-patch-ambiguous': report['ambiguous_failure_ids'] = [id]
        if patch == 'bad-patch-inconsistent': report['completed_ids'] = [id]
        if patch == 'bad-patch-markerless': log = 'Docker API error during fixture evaluation\\n'
        if patch == 'bad-patch-loose-marker': log = '2026-11-03 12:00:00,123 - INFO - candidate mentioned >>>>> Patch Apply Failed:\\n'
        if patch == 'bad-patch-oversized': log += 'x' * (8 * 1024 * 1024)
        instance_directory = Path(directory, 'evopt', id)
        instance_directory.mkdir(parents=True, exist_ok=True)
        Path(instance_directory, 'run_instance.log').write_text(log, encoding='utf-8')
    if patch != 'missing':
        Path(directory, 'results.json').write_text(json.dumps(report), encoding='utf-8')
    if patch == 'crash':
        print('fixture subprocess crashed after report', file=sys.stderr)
        sys.exit(3)
if __name__ == '__main__': main()
`);
  const options = { cwd, timeoutMs: 10_000 };
  await runProcess('git', ['init', '--quiet'], options);
  await runProcess('git', ['add', 'swebench', 'docker.py'], options);
  const identityOptions = { cwd: process.cwd(), timeoutMs: 10_000 };
  const name = (await runProcess('git', ['config', '--get', 'user.name'], identityOptions)).stdout.trim();
  const email = (await runProcess('git', ['config', '--get', 'user.email'], identityOptions)).stdout.trim();
  await runProcess('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add local evaluator fixture'], options);
  const revision = (await runProcess('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  return { cwd, python, revision };
}
