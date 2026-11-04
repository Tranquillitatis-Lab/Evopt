import type { Accounting, InvocationResult, Pricing, Proposer, ProposalRequest, RunContext } from '../types.ts';
export { defineOpenAIAgent } from './agents.ts';
export type { ProviderAgentOptions, ProviderAgentResult } from './agents.ts';

export interface OpenAIProposerOptions {
  apiKey: string;
  model: string;
  pricing: Pricing;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputTokenOverhead: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
}

/** Configure an optional paid proposer without global credentials or automatic requests. */
export function createOpenAIProposer<I, O>(options: OpenAIProposerOptions): Proposer<I, O> {
  if (!options?.apiKey?.trim() || !options.model?.trim()) throw new Error('OpenAI API key and model are required');
  options = { ...options, pricing: { ...options.pricing } };
  const pricing = options.pricing;
  if (!pricing?.source?.trim() || !Number.isFinite(Date.parse(pricing.checkedAt))) throw new Error('Pinned pricing source and date are required');
  for (const rate of [pricing.inputUSDPerMillion, pricing.outputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? 0]) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid OpenAI price');
  }
  for (const [name, value] of Object.entries({ maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
    inputTokenOverhead: options.inputTokenOverhead, timeoutMs: options.timeoutMs })) positiveInteger(value, name);
  if (options.inputTokenOverhead >= options.maxInputTokens) throw new Error('Input overhead leaves no input capacity');
  const inputRate = Math.max(pricing.inputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? Math.max(pricing.inputUSDPerMillion, pricing.outputUSDPerMillion));
  const maximumMicros = Math.ceil(options.maxInputTokens * inputRate + options.maxOutputTokens * pricing.outputUSDPerMillion);
  positiveInteger(maximumMicros, 'cost envelope');
  const accounting: Accounting = { kind: 'paid', version: 'openai-chat-v1', maxCostUSD: maximumMicros / 1_000_000,
    pricing: { ...pricing }, enforcement: 'One bounded request with no retries or paid tools',
    limits: { maxModelCalls: 1, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
      maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: options.timeoutMs } };
  const transport = options.fetch ?? globalThis.fetch;
  return {
    id: `openai:${options.model}`,
    version: `chat-completions-v1:${options.inputTokenOverhead}`,
    accounting,
    async propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>> {
      context.signal.throwIfAborted();
      const keys = Object.keys(request.mutable);
      const body = JSON.stringify({ model: options.model, stream: false, store: false, n: 1,
        max_completion_tokens: options.maxOutputTokens,
        messages: [
          { role: 'system', content: 'Improve only the declared prompt and tool-description text. Preserve required contracts. Use training feedback to reduce token use while preserving task quality. Return the declared text fields as JSON.' },
          { role: 'user', content: JSON.stringify(request) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'candidate', strict: true,
          schema: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])), required: keys, additionalProperties: false } } },
      });
      if (Buffer.byteLength(body, 'utf8') + options.inputTokenOverhead > options.maxInputTokens) throw new Error('OpenAI request exceeds the input envelope');
      const response = await transport('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)]), redirect: 'error',
      });
      if (!response.ok) throw new Error(`OpenAI request failed with HTTP ${response.status}`);
      const data = await response.json() as {
        id?: string; model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
        choices?: { message?: { content?: string } }[];
      };
      const inputTokens = data.usage?.prompt_tokens, outputTokens = data.usage?.completion_tokens;
      const cachedInputTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (data.model !== options.model) throw new Error('OpenAI returned a model outside the pinned pricing contract');
      if (!data.id || !data.model || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
        || (inputTokens as number) < 0 || (outputTokens as number) < 0
        || data.usage?.total_tokens !== (inputTokens as number) + (outputTokens as number)
        || !Number.isSafeInteger(cachedInputTokens) || cachedInputTokens < 0 || cachedInputTokens > (inputTokens as number)
        || !Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > (outputTokens as number)) {
        throw new Error('OpenAI returned incomplete usage');
      }
      let output: unknown = null;
      try { output = JSON.parse(data.choices?.[0]?.message?.content ?? 'null'); } catch { /* Keep billed usage for rejection. */ }
      return { output: output as Record<string, string>, usage: { complete: true, receipts: [{ id: data.id, provider: 'openai', model: data.model,
        inputTokens: inputTokens as number, outputTokens: outputTokens as number, cachedInputTokens, reasoningTokens }] } };
    },
  };
}
