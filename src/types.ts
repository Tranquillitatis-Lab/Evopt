export type Components = Readonly<Record<string, string>>;
export interface MutableComponent { role: string; maxLength: number }
export interface Limits {
  maxModelCalls: number; maxInputTokens: number; maxOutputTokens: number;
  maxPaidToolCalls: number; maxRetries: number; timeoutMs: number;
}
export interface Pricing {
  source: string; checkedAt: string;
  inputUSDPerMillion: number; outputUSDPerMillion: number;
  cacheReadUSDPerMillion?: number;
}
export type Accounting =
  | { kind: 'free'; timeoutMs: number }
  | { kind: 'paid'; maxCostUSD: number; limits: Limits; pricing: Pricing;
      enforcement: string; version: string };
export interface UsageReceipt {
  id: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  /** Included in outputTokens, never charged twice. */
  reasoningTokens?: number;
  /** Non-token charges, including paid tools. */
  extraCostUSD?: number;
}
export interface InvocationResult<O> {
  output: O; usage: { complete: true; receipts: UsageReceipt[] };
  trace?: readonly { type: string; [key: string]: unknown }[];
}
export interface RunContext {
  signal: AbortSignal; evaluationId: string;
  /** Paid adapters must enforce these limits for the whole invocation. */
  limits?: Readonly<Limits>;
}
export interface Case<I, O> { id: string; input: I; expected: O }
export interface Dataset<I, O> {
  id: string; version: string;
  train: readonly Case<I, O>[]; validation: readonly Case<I, O>[]; test: readonly Case<I, O>[];
  /** Local deterministic scorer; its version is covered by dataset.version. */
  score: (args: { input: I; output: O; expected: O }) => boolean | Promise<boolean>;
}
export interface TrainingFeedback<I, O> { caseId: string; input: I; expected: O; output: O; passed: boolean }
export interface ProposalRequest<I, O> {
  components: Components; mutable: Readonly<Record<string, MutableComponent>>;
  feedback: readonly TrainingFeedback<I, O>[]; attempt: number;
}
export interface Proposer<I = unknown, O = unknown> {
  id: string; version: string; accounting: Accounting;
  propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>>;
}
/** Strategies choose among scored candidates; only training/validation summaries are exposed. */
export interface SearchStrategy {
  id: string; version: string;
  select(candidates: readonly { id: string; trainAccuracy: number; validationAccuracy: number }[], incumbentId: string): string;
}
export interface Agent<I, O> {
  id: string; version: string; components: Components;
  mutable: Readonly<Record<string, MutableComponent>>;
  accounting: Accounting;
  run(args: { input: I; components: Components; context: RunContext }): Promise<InvocationResult<O>>;
  optimization: { proposer: Proposer<I, O>; maxAttempts?: number; strategy?: SearchStrategy };
}
export interface OptimizeOptions<I, O> {
  agent: Agent<I, O>; dataset: Dataset<I, O>; objective: 'accuracy'; budget: number;
  run?: { directory?: string; resume?: boolean; signal?: AbortSignal; includeTraces?: boolean };
}
export interface Evaluation<O> {
  id: string; candidateId: string; caseId: string; split: 'train' | 'validation' | 'test';
  output: O; passed: boolean; usage: UsageReceipt[]; trace?: InvocationResult<O>['trace'];
}
export interface Candidate { id: string; components: Components; trainAccuracy?: number; validationAccuracy?: number }
export interface LedgerEntry {
  id: string; purpose: string; reservedMicros: number; chargedMicros?: number;
  status: 'pending' | 'settled' | 'envelope_violation'; receipts?: UsageReceipt[];
}
export interface OptimizationResult<O> {
  status: 'completed' | 'interrupted'; reason?: string; directory: string;
  components: Components; changes: Record<string, { before: string; after: string }>;
  selectedId: string; candidates: Candidate[];
  history: { attempt: number; status: string; candidateId?: string; reason?: string }[];
  evaluations: Evaluation<O>[];
  test?: { kind: 'paired' | 'identity-control'; baselineAccuracy: number; candidateAccuracy: number };
  accounting: { currency: 'USD'; limitMicros: number; occupiedMicros: number; entries: LedgerEntry[] };
  provenance: { agentId: string; agentVersion: string; datasetId: string; datasetVersion: string; fingerprint: string; synthetic: boolean };
}
