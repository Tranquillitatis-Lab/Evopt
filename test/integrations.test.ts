import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listProviders, listFrameworkBridges, resolveProvider } from 'evopt';

const exec = promisify(execFile);
const cli = (...args: string[]) => exec(process.execPath, [resolve('bin/experiment.mjs'), ...args]);

test('catalog separates API runners from framework adapters and contributor assistants', async () => {
  const listing = JSON.parse((await cli('integrations')).stdout);
  assert.equal(listing.assistants.length, 9);
  assert.equal(listing.providers.length, 5);
  assert.ok(listing.assistants.every((a: any) => a.automaticTarget === false));
  assert.ok(listFrameworkBridges().every(f => f.status === 'custom-adapter-required' && !f.automaticTarget));
  assert.equal(resolveProvider('claude'), 'anthropic');
  assert.equal(resolveProvider('google'), 'gemini');
  assert.throws(() => resolveProvider('cursor'), /Unsupported metered provider/);
  assert.ok(listProviders().every(p => p.target && p.proposer));
});

test('assistant briefs are explicit offline onboarding and refuse overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evopt-onboard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'cursor.md');
  const output = JSON.parse((await cli('onboard', '--assistant', 'cursor', '--out', path)).stdout);
  assert.equal(output.inferenceRun, false); assert.equal(output.launchedAssistant, false);
  assert.match(await readFile(path, 'utf8'), /Cursor/);
  await assert.rejects(cli('onboard', '--assistant', 'cursor', '--out', path), /EEXIST/);
  await assert.rejects(cli('onboard', '--assistant', 'unknown', '--out', join(root, 'unknown.md')), /Unsupported contributor/);
});

test('each paid provider scaffold imports and preflights without dispatch or embedding credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evopt-provider-init-')); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = join(root, 'settings.json');
  await writeFile(settings, JSON.stringify({
    apiKey: 'mock-never-send', model: 'mock-model', maxAttempts: 1,
    pricing: { source: 'mock tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2 },
    maxInputTokens: 10000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000,
    baseURL: 'https://example.invalid/v1', provider: 'explicit-fixture',
  }));
  for (const provider of ['openai', 'claude', 'gemini', 'openai-compatible']) {
    const config = join(root, `${provider}.mjs`);
    const output = JSON.parse((await cli('init', '--provider', provider, '--settings', settings, '--out', config)).stdout);
    assert.equal(output.inferenceRun, false);
    assert.equal((await readFile(config, 'utf8')).includes('mock-never-send'), false);
    const check = JSON.parse((await cli('check', '--config', config, '--budget', '1')).stdout);
    assert.equal(check.paid, true); assert.equal(check.inferenceRun, false); assert.ok(check.minimumMicros > 0);
    await assert.rejects(cli('run', '--config', config, '--budget', '1', '--out', join(root, `${provider}-run`)), /allow-paid/);
  }
});

test('target selection rejects unsupported runtime names or missing settings before writing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evopt-provider-errors-')); t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'invalid.mjs');
  await assert.rejects(cli('init', '--provider', 'cursor', '--out', out), /Unsupported metered provider/);
  await assert.rejects(cli('init', '--provider', 'openai', '--out', out), /settings required/);
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});
