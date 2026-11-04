import type { Accounting, InvocationResult, Pricing, Proposer, ProposalRequest, RunContext } from '../types.ts';
export { defineAnthropicAgent, defineClaudeAgent } from './agents.ts';
export type { ProviderAgentOptions, ProviderAgentResult } from './agents.ts';

export interface AnthropicProposerOptions {
  apiKey: string;
  /** Pin the exact model ID returned by the API, not a changing alias. */
  model: string;
  pricing: Pricing;
  /** Upper bound for any cache-write TTL, in USD per million input tokens. */
  cacheWriteUSDPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Conservative allowance for provider framing and schema tokenization. */
  inputTokenOverhead: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One metered Messages API call; no global credentials, tools, retries, or implicit pricing. */
export function createAnthropicProposer<I, O>(options: AnthropicProposerOptions): Proposer<I, O> {
  if (!options?.apiKey?.trim() || !options.model?.trim()) throw new Error('Anthropic API key and pinned model are required');
  options = { ...options, pricing: { ...options.pricing } };
  const pricing = options.pricing;
  if (!pricing?.source?.trim() || !Number.isFinite(Date.parse(pricing.checkedAt))) throw new Error('Pinned pricing source and date are required');
  for (const rate of [pricing.inputUSDPerMillion, pricing.outputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? 0, options.cacheWriteUSDPerMillion]) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid Anthropic price');
  }
  for (const [name, value] of Object.entries({ maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
    inputTokenOverhead: options.inputTokenOverhead, timeoutMs: options.timeoutMs })) positiveInteger(value, name);
  if (options.timeoutMs > 2147483647) throw new Error('Invalid timeoutMs');
  if (options.inputTokenOverhead >= options.maxInputTokens) throw new Error('Input overhead leaves no input capacity');
  const inputRate = Math.max(pricing.inputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? Math.max(pricing.inputUSDPerMillion, pricing.outputUSDPerMillion), options.cacheWriteUSDPerMillion);
  // The ledger rounds normal token pricing and the cache-write surcharge separately.
  const maximumMicros = Math.ceil(options.maxInputTokens * inputRate + options.maxOutputTokens * pricing.outputUSDPerMillion) + 1;
  positiveInteger(maximumMicros, 'cost envelope');
  const accounting: Accounting = { kind: 'paid', version: 'anthropic-messages-v1', maxCostUSD: maximumMicros / 1_000_000,
    pricing: { ...pricing }, enforcement: 'One bounded standard-tier request with no retries or paid tools',
    limits: { maxModelCalls: 1, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
      maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: options.timeoutMs } };
  const transport = options.fetch ?? globalThis.fetch;
  return {
    id: `anthropic:${options.model}`,
    version: `messages-2023-06-01:${options.inputTokenOverhead}:cache-write-${options.cacheWriteUSDPerMillion}`,
    accounting,
    async propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>> {
      context.signal.throwIfAborted();
      const keys = Object.keys(request.mutable);
      const body = JSON.stringify({ model: options.model, max_tokens: options.maxOutputTokens, stream: false, service_tier: 'standard_only',
        system: 'Improve only the declared prompt and tool-description text. Preserve required contracts. Use training feedback to reduce token use while preserving task quality. Return the declared text fields as JSON.',
        messages: [{ role: 'user', content: JSON.stringify(request) }],
        output_config: { format: { type: 'json_schema', schema: { type: 'object',
          properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])), required: keys, additionalProperties: false } } } });
      if (Buffer.byteLength(body, 'utf8') + options.inputTokenOverhead > options.maxInputTokens) throw new Error('Anthropic request exceeds the input envelope');
      const response = await transport('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body, signal: AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)]), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Anthropic request failed with HTTP ${response.status}`);
      const data = await response.json() as {
        id?: string; model?: string; content?: { type?: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
          output_tokens_details?: { thinking_tokens?: number } | null; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null };
      };
      if (data.model !== options.model) throw new Error('Anthropic returned a model outside the pinned pricing contract');
      const input = data.usage?.input_tokens, output = data.usage?.output_tokens;
      const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0, cacheRead = data.usage?.cache_read_input_tokens ?? 0;
      const reasoning = data.usage?.output_tokens_details?.thinking_tokens;
      const toolUse = data.usage?.server_tool_use;
      if (typeof data.id !== 'string' || !data.id.trim() || !nonnegativeInteger(input) || !nonnegativeInteger(output)
        || !nonnegativeInteger(cacheWrite) || !nonnegativeInteger(cacheRead) || !Number.isSafeInteger(input + cacheWrite + cacheRead)
        || (reasoning !== undefined && (!nonnegativeInteger(reasoning) || reasoning > output))
        || (toolUse && (typeof toolUse !== 'object' || Array.isArray(toolUse) || Object.values(toolUse).some(value => value !== 0)))) {
        throw new Error('Anthropic returned incomplete or unmetered usage');
      }
      const extraCostUSD = cacheWrite * Math.max(0, options.cacheWriteUSDPerMillion - pricing.inputUSDPerMillion) / 1_000_000;
      let candidate: unknown = null;
      const text = Array.isArray(data.content) ? data.content.filter(block => block?.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join('') : '';
      try { candidate = JSON.parse(text); } catch { /* Return the receipt even if the output cannot be used. */ }
      return { output: candidate as Record<string, string>, usage: { complete: true, receipts: [{ id: data.id, provider: 'anthropic', model: options.model,
        inputTokens: input + cacheWrite + cacheRead, outputTokens: output, cachedInputTokens: cacheRead,
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }), ...(extraCostUSD ? { extraCostUSD } : {}) }] } };
    },
  };
}

/** Claude is the model family served by Anthropic's Messages API. */
export const createClaudeProposer = createAnthropicProposer;
