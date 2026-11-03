import type { Accounting, UsageReceipt } from './types.js';
import { assert, integer } from './validation.js';

/** Normalized cached input and reasoning tokens are subsets, never extra usage. */
export function usageTokens(receipts: readonly UsageReceipt[]): number {
  assert(Array.isArray(receipts), 'Missing normalized token receipts');
  let total = 0;
  for (const receipt of receipts) {
    integer(receipt.inputTokens); integer(receipt.outputTokens); integer(receipt.cachedInputTokens);
    assert(receipt.cachedInputTokens <= receipt.inputTokens, 'Invalid cached token subset');
    if (receipt.reasoningTokens !== undefined) {
      integer(receipt.reasoningTokens); assert(receipt.reasoningTokens <= receipt.outputTokens, 'Invalid reasoning token subset');
    }
    total += receipt.inputTokens + receipt.outputTokens; integer(total);
  }
  return total;
}

/** Paid limits apply to the whole invocation, including internal model steps. */
export function tokenEnvelope(accounting: Accounting): number {
  const total = accounting.kind === 'free' ? 0 : accounting.limits.maxInputTokens + accounting.limits.maxOutputTokens;
  integer(total); return total;
}
