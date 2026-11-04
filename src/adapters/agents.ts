import { defineAgent } from '../index.ts';
import type { Accounting, Agent, InvocationResult, RunContext, UsageReceipt } from '../types.ts';

/** The application must return every billed model response from this invocation. */
export interface ProviderAgentResult<O> {
  output: O;
  complete: boolean;
  paidToolsUsed: boolean;
  responses: readonly unknown[];
  trace?: InvocationResult<O>['trace'];
}

export interface ProviderAgentOptions<I, O> extends Omit<Agent<I, O>, 'accounting' | 'run'> {
  /** Exact billed model identifier; responses from any other model are rejected. */
  model: string;
  accounting: Extract<Accounting, { kind: 'paid' }>;
  /** Create fresh application state, enforce context limits, and report all billed calls. */
  run(args: { input: I; components: Agent<I, O>['components']; context: RunContext }): Promise<ProviderAgentResult<O>>;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, message: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as ObjectValue;
}

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function optionalCount(value: unknown, name: string): number {
  return value == null ? 0 : count(value, name);
}

function hasNonzeroCounts(value: unknown): boolean {
  if (value == null) return false;
  const details = object(value, 'Invalid provider tool usage');
  return Object.values(details).some(entry => count(entry, 'paid tool usage') > 0);
}

function responseIdentity(value: unknown, provider: string, model: string) {
  const response = object(value, `Invalid ${provider} response`);
  if (typeof response.id !== 'string' || !response.id.trim()) throw new Error(`Missing ${provider} response id`);
  if (response.model !== model) throw new Error(`${provider} response model differs from the pinned model`);
  return { id: response.id, usage: object(response.usage, `Missing ${provider} usage`) };
}

function openAIReceipt(value: unknown, model: string): UsageReceipt {
  const { id, usage } = responseIdentity(value, 'OpenAI', model);
  // Chat Completions and Responses APIs use different names for the same totals.
  const input = count(usage.input_tokens ?? usage.prompt_tokens, 'OpenAI input tokens');
  const output = count(usage.output_tokens ?? usage.completion_tokens, 'OpenAI output tokens');
  if (count(usage.total_tokens, 'OpenAI total tokens') !== input + output) throw new Error('OpenAI token totals differ');
  const inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details ?? {}, 'Invalid OpenAI input details');
  const outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details ?? {}, 'Invalid OpenAI output details');
  const cached = optionalCount(inputDetails.cached_tokens, 'OpenAI cached input tokens');
  const reasoning = optionalCount(outputDetails.reasoning_tokens, 'OpenAI reasoning tokens');
  if (cached > input || reasoning > output) throw new Error('OpenAI token subsets exceed totals');
  // A text-token tariff cannot safely price separate audio or other paid tool charges.
  if (optionalCount(inputDetails.audio_tokens, 'OpenAI input audio tokens') || optionalCount(outputDetails.audio_tokens, 'OpenAI output audio tokens')
    || hasNonzeroCounts(usage.server_tool_use)) throw new Error('OpenAI paid tools and audio usage are not supported');
  return { id, provider: 'openai', model, inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning };
}

function anthropicReceipt(value: unknown, model: string): UsageReceipt {
  const { id, usage } = responseIdentity(value, 'Anthropic', model);
  const input = count(usage.input_tokens, 'Anthropic input tokens');
  const output = count(usage.output_tokens, 'Anthropic output tokens');
  const cached = optionalCount(usage.cache_read_input_tokens, 'Anthropic cached input tokens');
  const created = optionalCount(usage.cache_creation_input_tokens, 'Anthropic cache creation tokens');
  // Cache creation can have a separate tariff not expressible by the current accounting contract.
  if (created || hasNonzeroCounts(usage.cache_creation) || hasNonzeroCounts(usage.server_tool_use)) throw new Error('Anthropic cache creation and paid tools are not supported');
  const total = input + cached;
  if (!Number.isSafeInteger(total)) throw new Error('Invalid Anthropic total input tokens');
  return { id, provider: 'anthropic', model, inputTokens: total, outputTokens: output, cachedInputTokens: cached };
}

function defineProviderAgent<I, O>(options: ProviderAgentOptions<I, O>, provider: 'OpenAI' | 'Anthropic'): Agent<I, O> {
  if (!options || typeof options.model !== 'string' || !options.model.trim()) throw new Error(`${provider} model must be pinned`);
  if (options.accounting?.kind !== 'paid' || options.accounting.limits?.maxPaidToolCalls !== 0) throw new Error(`${provider} requires paid accounting with no paid tools`);
  if (typeof options.run !== 'function') throw new Error(`${provider} agent callback is required`);
  const { model, run, ...agent } = options;
  return defineAgent<I, O>({ ...agent, accounting: { ...agent.accounting,
    version: JSON.stringify([agent.accounting.version, provider, model]) }, async run(args) {
    const result = await run(args);
    if (!result || result.complete !== true || result.paidToolsUsed !== false || !Array.isArray(result.responses) || result.responses.length === 0) {
      throw new Error(`${provider} agent must report complete usage and no paid tools`);
    }
    const receipts = result.responses.map(response => provider === 'OpenAI' ? openAIReceipt(response, model) : anthropicReceipt(response, model));
    return { output: result.output, usage: { complete: true, receipts }, ...(result.trace ? { trace: result.trace } : {}) };
  } });
}

/** Adapt an existing application that reports all OpenAI Responses or Chat Completions usage. */
export function defineOpenAIAgent<I, O>(options: ProviderAgentOptions<I, O>): Agent<I, O> {
  return defineProviderAgent(options, 'OpenAI');
}

/** Adapt an existing application that reports all Anthropic Messages usage. */
export function defineAnthropicAgent<I, O>(options: ProviderAgentOptions<I, O>): Agent<I, O> {
  return defineProviderAgent(options, 'Anthropic');
}

/** Claude is the model family exposed by Anthropic. */
export const defineClaudeAgent = defineAnthropicAgent;
