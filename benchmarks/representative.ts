import { save, assert } from '../src/common.ts';

// Deterministic local fixture strata, NOT a public benchmark or proof of external
// representativeness. Distinct data values in every split prevent literal overlap.
export function representativeTasks() {
  const tasks: any[] = [];
  for (const [split, offset] of [['train', 100], ['gate', 200], ['test', 300]] as const) {
    for (const [family, prompt, files, check] of [
      ['discovery', `Find the deeply nested configuration value needle_${offset}. Remember glob * does not cross directories.`, { 'a/b/config.txt': `needle_${offset}=${offset + 7}\n`, 'noise/config.txt': 'nothing\n' }, { type: 'answer-includes', value: String(offset + 7) }],
      ['paging', `Read the whole large file and report the unique END marker value, not just its first page.`, { 'large.txt': Array.from({ length: 2500 }, (_, i) => `row ${i}`).join('\n') + `\nEND=${offset + 9}\n` }, { type: 'answer-includes', value: String(offset + 9) }],
      ['multi-file-edit', `Change limit=${offset} to limit=${offset + 1} in setting.txt and refs/a.txt, keeping both newlines and leaving refs/b.txt unchanged.`, { 'setting.txt': `limit=${offset}\n`, 'refs/a.txt': `limit=${offset}\n`, 'refs/b.txt': 'do not edit\n' }, { type: 'files-equal', values: { 'setting.txt': `limit=${offset + 1}\n`, 'refs/a.txt': `limit=${offset + 1}\n`, 'refs/b.txt': 'do not edit\n' } }],
      ['aggregation', 'Sum all data values in data.csv, excluding the header.', { 'data.csv': `name,value\na,${offset}\nb,${offset + 2}\nc,${offset + 4}\n` }, { type: 'answer-includes', value: String(3 * offset + 6) }],
      ['triage', 'Find the first actionable failure code in logs and report it; ignore transient warnings.', { 'logs/run.txt': Array.from({ length: 200 }, () => 'WARN transient').join('\n') + `\nERROR actionable E${offset}\n` }, { type: 'answer-includes', value: `E${offset}` }],
      ['repair', `Repair config.json so retries is ${offset + 3}; preserve all other data and end the JSON with a newline.`, { 'config.json': `{"retries":${offset},"keep":true}\n`, 'failure.txt': `expected retries ${offset + 3}\n` }, { type: 'file-equals', path: 'config.json', value: `{"retries":${offset + 3},"keep":true}\n` }]
    ]) tasks.push({ id: `${family}-${split}`, split, family, prompt, files, check });
  }
  return tasks;
}
export async function writeRepresentativeSuite(file: string) {
  const tasks = representativeTasks(); assert(tasks.length === 18, 'Incomplete fixture strata');
  await save(file, tasks); return { file, tasks: tasks.length, publicBenchmark: false, families: 6 };
}
