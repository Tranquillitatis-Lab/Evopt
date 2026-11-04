import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, `Invalid ${label}`);
}

export const stable = (value: unknown): string => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const hash = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : stable(value)).digest('hex');
export const load = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));

export async function save(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
