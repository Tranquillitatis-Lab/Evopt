import type { CandidateLineage, ExperienceSettings, NormalizedExperienceSettings, TrainingExperience } from './experience.js';
export type Components = Readonly<Record<string, string>>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** Immutable JSON Schema metadata. Evopt does not execute schema extensions or resolve references. */
export type JsonSchema = boolean | { readonly [key: string]: JsonValue };
export interface ComponentTarget { readonly type: 'node' | 'tool'; readonly id: string }
export interface MutableComponent {
  role: string; maxLength: number;
  /** Required together with target when the adapter declares an AgentStructure. */
  kind?: 'prompt' | 'tool-description'; target?: ComponentTarget;
}
export interface AgentNode {
  readonly id: string; readonly role: string;
  readonly promptKeys: readonly string[]; readonly toolIds: readonly string[];
}
export interface AgentTool {
  readonly id: string; readonly descriptionKey: string;
  readonly inputSchema?: JsonSchema; readonly outputSchema?: JsonSchema;
  readonly constraints: readonly string[];
}
export interface AgentHandoff {
  readonly id: string; readonly from: string; readonly to: string;
  readonly description: string; readonly contract?: JsonValue;
}
/** Public, immutable context for text optimization; no runtime behavior is defined here. */
export interface AgentStructure {
  readonly version: 1;
  readonly nodes: readonly AgentNode[];
  readonly tools: readonly AgentTool[];
  readonly handoffs: readonly AgentHandoff[];
}
export interface AgentTextConfiguration {
  components: Components;
  mutable: Readonly<Record<string, MutableComponent>>;
  structure?: AgentStructure;
}
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
export interface BenchmarkProvenance {
  id: string; sourceRevision: string; sourceSha256: string; manifestSha256: string;
  metric: string; splitPolicy: 'custom-disjoint'; evaluator: { name: string; revision: string };
}
export interface Dataset<I, O> {
  id: string; version: string;
  train: readonly Case<I, O>[]; validation: readonly Case<I, O>[]; test: readonly Case<I, O>[];
  /** Local deterministic scorer; its version is covered by dataset.version. */
  score: (args: { input: I; output: O; expected: O }) => boolean | Promise<boolean>;
  /** Evidence metadata only; never forwarded to target invocations. */
  benchmark?: BenchmarkProvenance;
}
export interface TrainingFeedback<I, O> { caseId: string; input: I; expected: O; output: O; passed: boolean }
export interface ProposalRequest<I, O> {
  components: Components; mutable: Readonly<Record<string, MutableComponent>>;
  /** Roles, contracts, and fixed topology; contains references rather than immutable prompt text. */
  structure?: AgentStructure;
  feedback: readonly TrainingFeedback<I, O>[]; attempt: number;
  /** Bounded train-only comparisons and prior rejection facts. */
  experience?: TrainingExperience;
  selection?: SelectionPolicy;
}
export interface Proposer<I = unknown, O = unknown> {
  id: string; version: string; accounting: Accounting;
  propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>>;
}
export type SelectionPolicy =
  | { readonly kind: 'accuracy' }
  | { readonly kind: 'quality-constrained-resource'; readonly metric: 'usd' | 'tokens'; readonly minValidationAccuracy: number; readonly maxRegressions: number };
export interface CandidateSummary {
  id: string; trainAccuracy: number; validationAccuracy: number;
  /** Observed settled validation charges, including any paid tools. */
  validationCostMicros: number;
  /** Input + output tokens. Cached input and reasoning are subsets, never added twice. */
  validationTokens: number;
  /** Baseline-passing validation cases this candidate fails. */
  validationRegressions: number;
}
/** Strategies choose among scored candidates; only training/validation summaries are exposed. */
export interface SearchStrategy {
  id: string; version: string;
  select(candidates: readonly CandidateSummary[], incumbentId: string): string;
}
export interface Agent<I, O> {
  id: string; version: string; components: Components;
  mutable: Readonly<Record<string, MutableComponent>>;
  structure?: AgentStructure;
  accounting: Accounting;
  run(args: { input: I; components: Components; context: RunContext }): Promise<InvocationResult<O>>;
  optimization: { proposer: Proposer<I, O>; maxAttempts?: number; strategy?: SearchStrategy; selection?: SelectionPolicy; experience?: ExperienceSettings };
}
export interface OptimizeOptions<I, O> {
  agent: Agent<I, O>; dataset: Dataset<I, O>; objective: 'accuracy'; budget: number;
  run?: { directory?: string; resume?: boolean; signal?: AbortSignal; includeTraces?: boolean };
}
export interface Evaluation<O> {
  id: string; candidateId: string; caseId: string; split: 'train' | 'validation' | 'test';
  output: O; passed: boolean; usage: UsageReceipt[]; trace?: InvocationResult<O>['trace'];
}
export interface Candidate { id: string; components: Components; trainAccuracy?: number; validationAccuracy?: number; lineage?: CandidateLineage }
export interface LedgerEntry {
  id: string; purpose: string; reservedMicros: number; chargedMicros?: number;
  status: 'pending' | 'settled' | 'envelope_violation'; receipts?: UsageReceipt[];
}
export interface OptimizationResult<O> {
  status: 'completed' | 'interrupted'; reason?: string; directory: string;
  components: Components; changes: Record<string, { before: string; after: string }>;
  selectedId: string; candidates: Candidate[];
  history: { attempt: number; status: string; candidateId?: string; reason?: string; parentId?: string; proposalId?: string; changedKeys?: string[]; operator?: 'proposer-text-patch' }[];
  evaluations: Evaluation<O>[];
  test?: { kind: 'paired' | 'identity-control'; baselineAccuracy: number; candidateAccuracy: number };
  accounting: { currency: 'USD'; limitMicros: number; occupiedMicros: number; entries: LedgerEntry[] };
  /** Text permissions and immutable agent metadata, retained for reviewable patch export. */
  configuration?: { mutable: Readonly<Record<string, MutableComponent>>; structure?: AgentStructure; selection?: SelectionPolicy; experience?: NormalizedExperienceSettings };
  provenance: { agentId: string; agentVersion: string; datasetId: string; datasetVersion: string; fingerprint: string; synthetic: boolean; benchmark?: BenchmarkProvenance };
}
