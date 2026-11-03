import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAssistants, resolveAssistant, renderAssistantBrief } from '../src/assistants.js';

test('lists common contributor assistants without claiming automatic target support', () => {
  const assistants = listAssistants();
  assert.deepEqual(assistants.map(preset => preset.id), [
    'codex', 'claude-code', 'cursor', 'gemini-cli', 'github-copilot', 'opencode', 'aider', 'cline', 'roo-code',
  ]);
  assert.equal(new Set(assistants.map(preset => preset.name)).size, assistants.length);
  assert.ok(Object.isFrozen(assistants));
  for (const preset of assistants) {
    assert.ok(Object.isFrozen(preset));
    assert.equal(preset.kind, 'contributor-assistant');
    assert.equal(preset.automaticTarget, false);
    assert.equal(resolveAssistant(preset.id), preset);
  }
});

test('resolves familiar aliases and rejects unknown assistant names', () => {
  for (const [alias, id] of [
    ['openai', 'codex'], ['claude', 'claude-code'], ['copilot', 'github-copilot'], ['gemini', 'gemini-cli'],
  ]) assert.equal(resolveAssistant(alias!).id, id);
  assert.equal(resolveAssistant('  CURSOR ').name, 'Cursor');
  for (const name of ['', 'unknown', '__proto__', 'constructor']) assert.throws(() => resolveAssistant(name), /Unsupported/);
  assert.throws(() => resolveAssistant(null as unknown as string), /supported name/);
});

test('briefs give the full local workflow with explicit boundaries and no spending defaults', () => {
  for (const preset of listAssistants()) {
    const brief = renderAssistantBrief(preset.id);
    assert.ok(brief.includes(preset.name));
    for (const command of ['init', 'check', 'run', 'status', 'export', 'validate']) {
      assert.ok(brief.includes(`npm run experiment -- ${command}`));
    }
    assert.match(brief, /Read README\.md and CONTRIBUTING\.md first/);
    assert.match(brief, /not an automatic optimization-target adapter/);
    assert.match(brief, /--budget <USD_AMOUNT>/);
    assert.doesNotMatch(brief, /--budget\s+\d/);
    assert.match(brief, /add --allow-paid only when.*explicitly authorized/);
    assert.match(brief, /do not make paid calls while implementing/);
    assert.match(brief, /outside the Evopt ledger/);
    assert.match(brief, /fresh agent state and isolated tool fixtures/);
    assert.match(brief, /only training evidence/);
    assert.match(brief, /Do not tune on test results/);
    assert.match(brief, /Before export, review/);
    assert.match(brief, /Do not publish, open a PR, merge, install a candidate/);
  }
  assert.equal(renderAssistantBrief('openai'), renderAssistantBrief('codex'));
});
