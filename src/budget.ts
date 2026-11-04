import { assert, integer } from './common.ts';
import type { Accounting, UsageReceipt } from './types.ts';
export function budgetMicros(value: number): number { assert(typeof value === 'number' && Number.isFinite(value) && value > 0, 'Positive USD budget required'); const amount = Math.floor(value * 1e6); integer(amount, 1, Number.MAX_SAFE_INTEGER, 'USD budget'); return amount; }
export function validateAccounting(accounting: Accounting): {
    micros: number;
    tokens: number;
} {
    assert(accounting && typeof accounting === 'object', 'Metered accounting required');
    if (accounting.kind === 'free') {
        integer(accounting.timeoutMs, 1, 2147483647, 'timeoutMs');
        return { micros: 0, tokens: 0 };
    }
    assert(accounting.kind === 'paid' && typeof accounting.version === 'string' && !!accounting.version && typeof accounting.enforcement === 'string' && !!accounting.enforcement, 'Unmetered paid integration');
    const l = accounting.limits, p = accounting.pricing;
    assert(l && p && !!p.source && !!p.checkedAt && Number.isFinite(Date.parse(p.checkedAt)), 'Pinned pricing and invocation limits required');
    for (const key of ['maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxPaidToolCalls', 'maxRetries'] as const)
        integer(l[key], 0, Number.MAX_SAFE_INTEGER, key);
    integer(l.timeoutMs, 1, 2147483647, 'timeoutMs');
    for (const value of [p.inputUSDPerMillion, p.outputUSDPerMillion, p.cacheReadUSDPerMillion ?? 0])
        assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Invalid tariff');
    const amount = Math.ceil(accounting.maxCostUSD * 1e6);
    integer(amount, 1, Number.MAX_SAFE_INTEGER, 'maxCostUSD');
    const maximum = Math.ceil(l.maxInputTokens * Math.max(p.inputUSDPerMillion, p.cacheReadUSDPerMillion ?? Math.max(p.inputUSDPerMillion, p.outputUSDPerMillion)) + l.maxOutputTokens * p.outputUSDPerMillion);
    assert(amount >= maximum, 'Invocation envelope does not cover token limits');
    const tokens = l.maxInputTokens + l.maxOutputTokens;
    integer(tokens, 0, Number.MAX_SAFE_INTEGER, 'token envelope');
    return { micros: amount, tokens };
}
export function priceUsage(usage: {
    complete: true;
    receipts: UsageReceipt[];
}, accounting: Accounting, seen = new Set<string>()): {
    tokens: number;
    micros: number;
    ids: string[];
    violation?: boolean;
} {
    assert(usage?.complete === true && Array.isArray(usage.receipts), 'Complete normalized usage receipts required');
    if (accounting.kind === 'paid')
        assert(usage.receipts.length > 0, 'Paid invocation requires receipts');
    let input = 0, output = 0, cached = 0, extras = 0;
    const ids = new Set<string>();
    for (const receipt of usage.receipts) {
        assert(receipt && !!receipt.id && !!receipt.provider && !!receipt.model, 'Invalid receipt');
        const key = JSON.stringify([receipt.provider, receipt.id]);
        assert(!ids.has(key) && !seen.has(key), 'Duplicate or reused receipt');
        ids.add(key);
        for (const name of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const)
            integer(receipt[name], 0, Number.MAX_SAFE_INTEGER, name);
        assert(receipt.cachedInputTokens <= receipt.inputTokens, 'Cache tokens must be input subset');
        if (receipt.reasoningTokens !== undefined)
            integer(receipt.reasoningTokens, 0, receipt.outputTokens, 'reasoning subset');
        const extra = receipt.extraCostUSD ?? 0;
        assert(typeof extra === 'number' && Number.isFinite(extra) && extra >= 0, 'Invalid paid-tool charge');
        input += receipt.inputTokens;
        output += receipt.outputTokens;
        cached += receipt.cachedInputTokens;
        extras += Math.ceil(extra * 1e6);
        integer(input, 0, Number.MAX_SAFE_INTEGER, 'input');
        integer(output, 0, Number.MAX_SAFE_INTEGER, 'output');
        integer(extras, 0, Number.MAX_SAFE_INTEGER, 'extras');
    }
    const tokens = input + output;
    integer(tokens, 0, Number.MAX_SAFE_INTEGER, 'tokens');
    if (accounting.kind === 'free') {
        assert(tokens === 0 && extras === 0, 'Free integration reported paid usage');
        return { tokens: 0, micros: 0, ids: [...ids] };
    }
    const l = accounting.limits, p = accounting.pricing, micros = Math.ceil((input - cached) * p.inputUSDPerMillion + cached * (p.cacheReadUSDPerMillion ?? Math.max(p.inputUSDPerMillion, p.outputUSDPerMillion)) + output * p.outputUSDPerMillion) + extras;
    integer(micros, 0, Number.MAX_SAFE_INTEGER, 'charge');
    return { tokens, micros, ids: [...ids], violation: input > l.maxInputTokens || output > l.maxOutputTokens || usage.receipts.filter(r => r.inputTokens + r.outputTokens > 0).length > l.maxModelCalls || micros > validateAccounting(accounting).micros };
}
