export type Components = Readonly<Record<string, string>>;

export interface MutableComponent {
  role: string;
  maxLength: number;
}

export interface UsageReceipt {
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens?: number;
  extraCostUSD?: number;
}

export interface Limits {
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxPaidToolCalls: number;
  maxRetries: number;
  timeoutMs: number;
}

export interface Pricing {
  source: string;
  checkedAt: string;
  inputUSDPerMillion: number;
  outputUSDPerMillion: number;
  cacheReadUSDPerMillion?: number;
}

export type Accounting =
  | { kind: 'free'; timeoutMs: number }
  | { kind: 'paid'; version: string; maxCostUSD: number; limits: Limits; pricing: Pricing; enforcement: string };

export interface RunContext {
  signal: AbortSignal;
  evaluationId: string;
  limits?: Readonly<Limits>;
}

export interface InvocationResult<O> {
  output: O;
  usage: { complete: true; receipts: UsageReceipt[] };
  trace?: readonly { type: string; [key: string]: unknown }[];
}

export interface Case<I, O> {
  id: string;
  input: I;
  expected: O;
}

export interface Dataset<I, O> {
  id: string;
  version: string;
  train: readonly Case<I, O>[];
  validation: readonly Case<I, O>[];
  test: readonly Case<I, O>[];
  score(args: { input: I; output: O; expected: O }): boolean | Promise<boolean>;
}

export interface ProposalRequest<I, O> {
  components: Components;
  mutable: Readonly<Record<string, MutableComponent>>;
  feedback: readonly { caseId: string; input: I; expected: O; output: O; passed: boolean }[];
  attempt: number;
  experience?: unknown;
  structure?: AgentStructure;
  evolution?: { lane: Lane; parents: readonly Components[] };
}

export interface Proposer<I = unknown, O = unknown> {
  id: string;
  version: string;
  accounting: Accounting;
  propose(request: ProposalRequest<I, O>, context: RunContext): Promise<InvocationResult<Record<string, string>>>;
}

/** Read-only context for mutation proposals; Evopt never rewrites these relationships. */
export interface AgentStructure {
  nodes?: readonly { id: string; role: string; components?: readonly string[] }[];
  tools?: readonly { id: string; contract: string; descriptionComponent?: string }[];
  handoffs?: readonly { from: string; to: string; description?: string }[];
}

export interface Agent<I, O> {
  id: string;
  version: string;
  components: Components;
  mutable: Readonly<Record<string, MutableComponent>>;
  structure?: AgentStructure;
  accounting: Accounting;
  run(args: { input: I; components: Components; context: RunContext }): Promise<InvocationResult<O>>;
  optimization: { proposer: Proposer<I, O>; maxAttempts?: number };
}

export type Gene =
  | { type: 'text'; initial: string; maxChars: number; required?: string[] }
  | { type: 'choice'; initial: string; values: string[]; required?: string[] };

export interface Lane {
  id: string;
  scope: string;
  protectedPolicy: string;
  genes: Record<string, Gene>;
  seeds?: Record<string, string>[];
}

export interface OptimizeOptions<I, O> {
  agent: Agent<I, O>;
  dataset: Dataset<I, O>;
  objective?: 'tokens' | 'accuracy';
  /** Total optimization-run ceiling in USD. */
  budget: number;
  run?: { directory?: string; resume?: boolean; signal?: AbortSignal; maxTokens?: number };
}

export interface OptimizationResult<O> {
  status: 'completed' | 'interrupted';
  reason?: string;
  directory: string;
  components: Components;
  changes: Record<string, { before: string; after: string }>;
  evaluations: readonly { caseId: string; output: O; passed: boolean }[];
  test?: { baselineAccuracy: number; candidateAccuracy: number };
  accounting: { currency: 'USD'; limitMicros: number; occupiedMicros: number; entries: readonly unknown[] };
}
