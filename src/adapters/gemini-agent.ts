import { defineAgent } from '../index.ts';
import type { Agent, UsageReceipt } from '../types.ts';
import type { ProviderAgentOptions, ProviderAgentResult } from './agents.ts';

/** Only text-token pricing without hosted tools or explicit cache storage is supported. */
export interface GeminiAgentResult<O> extends ProviderAgentResult<O> {
  textOnly: boolean;
  explicitCacheUsed: boolean;
}

export interface GeminiAgentOptions<I, O> extends Omit<ProviderAgentOptions<I, O>, 'run'> {
  /** Create fresh agent state, enforce limits, and provide every billed response. */
  run: (args: Parameters<ProviderAgentOptions<I, O>['run']>[0]) => Promise<GeminiAgentResult<O>>;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Gemini ${label}`);
  return value as JsonObject;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Gemini ${label}`);
  return value;
}

function optionalCount(value: unknown, label: string): number {
  return value === undefined ? 0 : count(value, label);
}

function validateModalities(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`Invalid Gemini ${label}`);
  for (const detail of value) {
    const row = object(detail, label);
    count(row.tokenCount, `${label} token count`);
    if (row.modality !== 'TEXT') throw new Error('Gemini non-text modality pricing is not supported');
  }
}

/** Convert a complete GenerateContent response into the normalized usage contract. */
export function normalizeGeminiUsage(value: unknown, model: string): UsageReceipt {
  const response = object(value, 'response');
  if (typeof response.responseId !== 'string' || !response.responseId.trim()) throw new Error('Missing Gemini response id');
  if (response.modelVersion !== model) throw new Error('Gemini response model differs from the pinned model');
  const usage = object(response.usageMetadata, 'usage metadata');
  const input = count(usage.promptTokenCount, 'input tokens');
  const candidates = optionalCount(usage.candidatesTokenCount, 'candidate tokens');
  const thoughts = optionalCount(usage.thoughtsTokenCount, 'thought tokens');
  const cached = optionalCount(usage.cachedContentTokenCount, 'cached input tokens');
  const toolTokens = optionalCount(usage.toolUsePromptTokenCount, 'tool input tokens');
  const total = count(usage.totalTokenCount, 'total tokens');
  const output = candidates + thoughts;
  if (!Number.isSafeInteger(output) || !Number.isSafeInteger(input + output)
    || total !== input + output + toolTokens || cached > input) throw new Error('Gemini token totals differ or exceed safe limits');
  if (toolTokens !== 0) throw new Error('Gemini hosted tool use is not supported');
  for (const name of ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails']) {
    validateModalities(usage[name], name);
  }
  if (Array.isArray(usage.toolUsePromptTokensDetails)
    && usage.toolUsePromptTokensDetails.some(row => object(row, 'tool usage detail').tokenCount !== 0)) {
    throw new Error('Gemini hosted tool use is not supported');
  }
  if (usage.serviceTier !== undefined && !['standard', 'unspecified', 'STANDARD', 'SERVICE_TIER_STANDARD', 'SERVICE_TIER_UNSPECIFIED'].includes(String(usage.serviceTier))) {
    throw new Error('Gemini service tier differs from the standard pricing contract');
  }
  if (Array.isArray(response.candidates)) {
    for (const candidate of response.candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const row = candidate as JsonObject;
      if (row.groundingMetadata != null || row.urlContextMetadata != null) throw new Error('Gemini grounding and hosted tools are not supported');
    }
  }
  return { id: response.responseId, provider: 'gemini', model, inputTokens: input, outputTokens: output,
    cachedInputTokens: cached, reasoningTokens: thoughts };
}

/** Wrap an existing text-only application; no SDK, credentials, or inference is implicit. */
export function defineGeminiAgent<I, O>(options: GeminiAgentOptions<I, O>): Agent<I, O> {
  if (!options || typeof options.model !== 'string' || !options.model.trim()) throw new Error('Gemini model must be pinned');
  if (options.accounting?.kind !== 'paid' || options.accounting.limits?.maxPaidToolCalls !== 0) {
    throw new Error('Gemini requires paid accounting with no paid tools');
  }
  if (typeof options.run !== 'function') throw new Error('Gemini agent callback is required');
  const { model, run, ...agent } = options;
  const accounting = structuredClone(agent.accounting);
  accounting.version = JSON.stringify([accounting.version, 'Gemini', model]);
  return defineAgent<I, O>({ ...agent, accounting, async run(args) {
    const result = await run(args);
    if (!result || result.complete !== true || result.paidToolsUsed !== false || result.textOnly !== true
      || result.explicitCacheUsed !== false || !Array.isArray(result.responses) || result.responses.length === 0) {
      throw new Error('Gemini agent must report complete text-only usage, no explicit cache, and no paid tools');
    }
    const receipts = result.responses.map(response => normalizeGeminiUsage(response, model));
    return { output: result.output, usage: { complete: true, receipts }, ...(result.trace ? { trace: result.trace } : {}) };
  } });
}
