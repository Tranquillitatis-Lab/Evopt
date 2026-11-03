// Opt-in paid smoke experiment. Importing this module never dispatches inference.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineAgent, defineExperiment, exactMatch } from 'evopt';
import { createOpenAIProposer } from 'evopt/openai';

const settingsPath = process.env.EVOPT_EXPERIMENT_SETTINGS;
if (!settingsPath?.trim()) throw new Error('Set EVOPT_EXPERIMENT_SETTINGS to your reviewed private settings JSON path');
const settings = JSON.parse(await readFile(resolve(settingsPath), 'utf8'));
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
if (!Number.isSafeInteger(settings.maxAttempts) || settings.maxAttempts < 0) throw new Error('Set an explicit nonnegative maxAttempts');

// This constructor validates explicit model, credentials, tariff, and all limits.
// Credentials stay in these closures, never in exported accounting metadata.
const proposer = createOpenAIProposer({
  apiKey: settings.apiKey, model: settings.model, pricing: settings.pricing,
  maxInputTokens: settings.maxInputTokens, maxOutputTokens: settings.maxOutputTokens,
  inputTokenOverhead: settings.inputTokenOverhead, timeoutMs: settings.timeoutMs,
});
const { apiKey, model, maxInputTokens, maxOutputTokens, inputTokenOverhead, timeoutMs, maxAttempts } = settings;

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid OpenAI ${field}; billing unresolved`);
  return value;
}
function normalizeUsage(data) {
  if (typeof data?.id !== 'string' || !data.id || typeof data?.model !== 'string' || !data.model) {
    throw new Error('Missing OpenAI response identity; billing unresolved');
  }
  const usage = data.usage;
  const inputTokens = integer(usage?.prompt_tokens, 'prompt_tokens');
  const outputTokens = integer(usage?.completion_tokens, 'completion_tokens');
  if (integer(usage?.total_tokens, 'total_tokens') !== inputTokens + outputTokens) throw new Error('OpenAI token totals disagree; billing unresolved');
  const cachedInputTokens = integer(usage.prompt_tokens_details?.cached_tokens ?? 0, 'cached_tokens');
  const reasoningTokens = integer(usage.completion_tokens_details?.reasoning_tokens ?? 0, 'reasoning_tokens');
  if (cachedInputTokens > inputTokens || reasoningTokens > outputTokens) throw new Error('Invalid OpenAI token subsets; billing unresolved');
  if (usage.prompt_tokens_details?.cache_write_tokens > 0) throw new Error('Cache-write pricing is unsupported; billing unresolved');
  return { id: data.id, provider: 'openai', model: data.model, inputTokens, outputTokens, cachedInputTokens, reasoningTokens };
}

const agent = defineAgent({
  id: 'openai-text-normalization-smoke',
  version: `chat-text-v1:${model}:overhead=${inputTokenOverhead}`,
  components: { systemPrompt: 'Normalize the category name. Return only the normalized category.' },
  mutable: { systemPrompt: { role: 'Category normalization instructions', maxLength: 1000 } },
  accounting: {
    ...proposer.accounting,
    version: 'openai-target-text-v1',
    enforcement: `One text completion per invocation, no retries or tools; UTF-8 request bytes plus ${inputTokenOverhead} reviewed framing tokens bounded by maxInputTokens; max_completion_tokens bounds output.`,
  },
  optimization: { proposer, maxAttempts },
  async run({ input, components, context }) {
    context.signal.throwIfAborted();
    // A new request with no conversation history creates fresh target state.
    const body = JSON.stringify({
      model, stream: false, store: false, n: 1, max_completion_tokens: maxOutputTokens,
      messages: [
        { role: 'system', content: components.systemPrompt },
        { role: 'user', content: input },
      ],
    });
    if (Buffer.byteLength(body, 'utf8') + inputTokenOverhead > maxInputTokens) {
      throw new Error('Target request exceeds conservative input envelope before dispatch');
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(`OpenAI target HTTP ${response.status}; billing unresolved`);
    const data = await response.json();
    const receipt = normalizeUsage(data);
    const choice = data.choices?.[0];
    // Refusal/truncation is a failed case, but its complete usage still settles.
    const output = choice?.finish_reason === 'stop' && !choice.message?.refusal && typeof choice.message?.content === 'string'
      ? choice.message.content : '';
    return { output, usage: { complete: true, receipts: [receipt] } };
  },
});

export default defineExperiment({
  id: 'openai-text-normalization-smoke',
  description: 'Opt-in paid wiring smoke test on six public category-normalization fixtures; not a benchmark or production improvement claim.',
  agent, objective: 'accuracy',
  dataset: {
    id: 'public-category-normalization-smoke', version: '1', score: exactMatch,
    train: [
      { id: 'train-books', input: '  BOOKS ', expected: 'books' },
      { id: 'train-home', input: 'Home   &  Garden', expected: 'home & garden' },
    ],
    validation: [
      { id: 'validation-music', input: '  MUSIC', expected: 'music' },
      { id: 'validation-arts', input: ' Arts   &   Crafts ', expected: 'arts & crafts' },
    ],
    test: [
      { id: 'test-film', input: ' FILM  ', expected: 'film' },
      { id: 'test-sports', input: '  Sports   Outdoors ', expected: 'sports outdoors' },
    ],
  },
});
