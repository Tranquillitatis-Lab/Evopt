import type { Accounting, InvocationResult, Pricing, Proposer, ProposalRequest, RunContext } from '../types.ts';
import { normalizeGeminiUsage } from './gemini-agent.ts';
export { defineGeminiAgent } from './gemini-agent.ts';
export type { GeminiAgentOptions, GeminiAgentResult } from './gemini-agent.ts';

export interface GeminiProposerOptions {
  apiKey: string;
  /** Exact model version returned by the Gemini API, not a moving alias. */
  model: string;
  /** Conservative text-token rates, including all applicable pricing tiers. */
  pricing: Pricing;
  maxInputTokens: number;
  /** Includes both generated text and thinking tokens. */
  maxOutputTokens: number;
  /** Conservative allowance for provider framing and schema tokenization. */
  inputTokenOverhead: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
}

/** A single metered, text-only Gemini request, without tools or explicit caches. */
export function createGeminiProposer<I, O>(options: GeminiProposerOptions): Proposer<I, O> {
  if (!options?.apiKey?.trim() || !options.model?.trim()) throw new Error('Gemini API key and pinned model are required');
  options = { ...options, pricing: { ...options.pricing } };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model)) throw new Error('Gemini model must be a bare pinned model ID');
  const pricing = options.pricing;
  if (!pricing?.source?.trim() || !Number.isFinite(Date.parse(pricing.checkedAt))) throw new Error('Pinned pricing source and date are required');
  for (const rate of [pricing.inputUSDPerMillion, pricing.outputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? 0]) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid Gemini price');
  }
  for (const [name, value] of Object.entries({ maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
    inputTokenOverhead: options.inputTokenOverhead, timeoutMs: options.timeoutMs })) positiveInteger(value, name);
  if (options.timeoutMs > 2_147_483_647) throw new Error('Invalid timeoutMs');
  if (options.inputTokenOverhead >= options.maxInputTokens) throw new Error('Input overhead leaves no input capacity');
  const inputRate = Math.max(pricing.inputUSDPerMillion, pricing.cacheReadUSDPerMillion ?? Math.max(pricing.inputUSDPerMillion, pricing.outputUSDPerMillion));
  const maximumMicros = Math.ceil(options.maxInputTokens * inputRate + options.maxOutputTokens * pricing.outputUSDPerMillion);
  positiveInteger(maximumMicros, 'cost envelope');
  const accounting: Accounting = { kind: 'paid', version: 'gemini-generate-content-v1beta', maxCostUSD: maximumMicros / 1_000_000,
    pricing: { ...pricing }, enforcement: 'One bounded text-only standard request with no retries, tools or explicit cache',
    limits: { maxModelCalls: 1, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
      maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: options.timeoutMs } };
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new Error('A fetch implementation is required');
  return {
    id: `gemini:${options.model}`,
    version: `generate-content-v1beta:${options.inputTokenOverhead}`,
    accounting,
    async propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>> {
      context.signal.throwIfAborted();
      const keys = Object.keys(request.mutable);
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: 'Improve only the declared prompt and tool-description text. Preserve required contracts. Use training feedback to reduce token use while preserving task quality. Return the declared text fields as JSON.' }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(request) }] }],
        generationConfig: { maxOutputTokens: options.maxOutputTokens, candidateCount: 1, responseModalities: ['TEXT'],
          responseMimeType: 'application/json', responseJsonSchema: { type: 'object',
            properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])), required: keys, additionalProperties: false } },
      });
      if (Buffer.byteLength(body, 'utf8') + options.inputTokenOverhead > options.maxInputTokens) throw new Error('Gemini request exceeds the input envelope');
      const response = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': options.apiKey, 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)]), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Gemini request failed with HTTP ${response.status}`);
      const data: unknown = await response.json();
      // Usage is normalized before candidate parsing so invalid or blocked text remains billable.
      const receipt = normalizeGeminiUsage(data, options.model);
      const result = data as { candidates?: { finishReason?: string; content?: { parts?: { text?: unknown; thought?: boolean }[] } }[] };
      const candidate = Array.isArray(result.candidates) && result.candidates.length === 1 ? result.candidates[0] : undefined;
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const validParts = parts.every(part => part && typeof part === 'object' && typeof part.text === 'string'
        && !Object.hasOwn(part, 'functionCall') && !Object.hasOwn(part, 'inlineData'));
      const textParts = parts.filter(part => part && part.thought !== true);
      let output: unknown = null;
      if (candidate?.finishReason === 'STOP' && validParts && textParts.length > 0) {
        try { output = JSON.parse(textParts.map(part => part.text).join('')); } catch { /* Keep billed usage for rejection. */ }
      }
      return { output: output as Record<string, string>, usage: { complete: true, receipts: [receipt] } };
    },
  };
}
