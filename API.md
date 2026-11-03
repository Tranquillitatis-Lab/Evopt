# API reference

This reference covers explicit setup, integration, selection, accounting, evidence, and recovery. Start with the [README](README.md) for the concept, or run the complete [offline example](examples/offline.ts) with `npm run demo`.

## Complete offline example

The package root exports `defineAgent`, `optimize`, `exactMatch`, `createOfflineProposer`, `accuracyStrategy`, and public TypeScript types. This complete example needs no credentials or global SDK configuration. It explicitly selects accuracy to demonstrate a text change; a free fixture with no token receipts cannot establish token savings:

```ts
import {
  defineAgent, optimize, exactMatch, createOfflineProposer,
  type Dataset,
} from "evopt";

const agent = defineAgent<string, string>({
  id: "category-agent",
  version: "1",
  components: {
    systemPrompt: "Classify the message.",
    lookupToolDescription: "Look up a category in the fixed catalog.",
  },
  mutable: {
    systemPrompt: { role: "Classification instructions", maxLength: 500 },
    lookupToolDescription: { role: "Catalog lookup description", maxLength: 300 },
  },
  accounting: { kind: "free", timeoutMs: 1_000 },
  async run({ input, components, context }) {
    context.signal.throwIfAborted();
    // Deterministic stand-in for an existing agent; no model call.
    const output = components.systemPrompt!.includes("lowercase")
      ? input.toLowerCase()
      : input;
    return { output, usage: { complete: true, receipts: [] } };
  },
  optimization: {
    proposer: createOfflineProposer<string, string>([
      { systemPrompt: "Return the category in lowercase." },
    ]),
    maxAttempts: 1,
  },
});

const dataset: Dataset<string, string> = {
  id: "categories",
  version: "1",
  train: [{ id: "train-1", input: "BOOK", expected: "book" }],
  validation: [{ id: "validation-1", input: "MUSIC", expected: "music" }],
  test: [{ id: "test-1", input: "FILM", expected: "film" }],
  score: exactMatch,
};

const result = await optimize({
  agent,
  dataset,
  objective: "accuracy",
  budget: 10,
});

console.log(result.status, result.changes, result.test, result.directory);
```

`budget: 10` means a USD 10 total optimization-run ceiling, not ten iterations or a subscription balance. This example spends zero because both integrations are free and local. An example budget is not authorization for contributors to run paid experiments.

All three partitions must be nonempty, with globally unique case ids and no identical inputs across partitions. Inputs and outputs must be JSON-serializable data suitable for durable evidence. The local scorer receives `{ input, output, expected }` and returns a boolean, optionally asynchronously. It must be deterministic and free of paid calls. Use an application-specific scorer where exact matching is unsuitable. Increase `dataset.version` when changing scoring behavior. Component `maxLength` uses JavaScript string length (UTF-16 code units).

Omitting `objective` defaults to `"tokens"`; explicit `"tokens"` and `"accuracy"` are supported. Token optimization requires strictly fewer validation tokens while meeting baseline quality guards. Higher accuracy alone does not win under that objective. Invalid budgets, missing mutable components, malformed datasets, unsupported objectives, and incomplete paid accounting settings fail before provider dispatch.

`budget` is always a USD ceiling. Optionally add `run: { maxTokens: 200000 }` to `optimize` for a separate total token ceiling covering target and proposer calls. Choose both limits explicitly; the number here is illustrative, not authorization.

## Public types and configuration

Generic input and output types flow through `defineAgent<I, O>`, `Agent<I, O>`, `Dataset<I, O>`, `Proposer<I, O>`, `OptimizeOptions<I, O>`, and `OptimizationResult<O>`. All are exported from `evopt`; typed adapters do not need to erase their inputs or outputs.

`defineAgent` captures the stable agent id and implementation version, initial components, mutable roles/length limits, runner callback, invocation accounting, and explicit optimization settings. Use `optimization.maxAttempts` to bound proposal attempts independently of the USD ceiling. There is no implicit proposer or global SDK setup.

The package root also exports configuration mapping and patch helpers, evidence analysis, experiment/contribution helpers, `SelectionPolicy`, `TrainingExperience`, and `CandidateLineage`. See [the public exports](src/index.ts) and [type definitions](src/types.ts) for the complete contract.

For SWE-bench, `loadSWEExperiment(configPath)` reads an explicit JSON configuration, verifies local evaluator resources, then imports its named agent export and returns a tokens-objective experiment. It is also the loader behind `npm run swe`; see [SWE setup](experiments/swe-bench/README.md).

Optional `AgentStructure` declares nodes, tools, and handoffs. `mapOpenAIChatConfiguration` and `mapAnthropicConfiguration` map its named text into provider configuration; they make no requests or tool calls. See [structured configuration](CONFIGURATION.md).

## Adapt an existing agent

Replace the example's `run` callback with the bridge into your application. Import your existing agent constructor and create a fresh instance inside every invocation:

```ts
async run({ input, components, context }) {
  const instance = createYourExistingAgent({
    systemPrompt: components.systemPrompt,
    lookupToolDescription: components.lookupToolDescription,
    sessionId: context.evaluationId,
    limits: context.limits,
  });
  return instance.runWithNormalizedReceipts(input, {
    signal: context.signal,
  });
}
```

`createYourExistingAgent` and `runWithNormalizedReceipts` represent application code, not Evopt exports. The adapter must wire the supplied text into the actual prompt and tool-description fields used by its agent; declaring a component alone cannot change the underlying framework.

Evopt supplies cloned inputs, an immutable component snapshot, a fresh evaluation id, and an AbortSignal. It does not pass the expected answer, scoring callback, dataset, or previous conversation to the target agent. Create new conversation memory, checkpoints, tool fixtures, and side-effect namespaces for every invocation, and clean them up in your adapter. Never point evaluation tools at production state.

An adapter callback is trusted code. Evopt cannot prevent it from capturing labels in a closure, reusing external state, ignoring cancellation, or bypassing limits. This library is not an OS sandbox. Component limits bound editable text, not arbitrary runtime behavior.

## Search and evidence

The default strategy is bounded mutation and selection, with ten proposal attempts unless `optimization.maxAttempts` changes it. Execution is sequential, with one evaluation per case and candidate. The proposer is separate from the runner. It receives current mutable text, its specifications, optional agent structure, the selection policy, current-incumbent labeled training feedback, and bounded training experience across earlier candidates and rejections. The experience projection includes per-case outcomes, resource comparisons, mutable edits, and lineage; it omits raw historical outputs. Validation and test observations never enter proposals.

Each proposal is a patch containing allowlisted component keys. Invalid, oversized, empty, and duplicate proposals are recorded without candidate evaluation. Baseline and valid candidates receive train and validation evaluations. The default tokens objective requires strictly lower validation token use, at least baseline validation accuracy, and zero regressions on baseline-passing cases. Equal-token candidates retain the incumbent even if accuracy improves.

Explicit `objective: "accuracy"` retains accuracy-first selection: higher validation accuracy wins and ties retain the incumbent. An optional `optimization.strategy` can replace that accuracy selector through the exported `SearchStrategy` interface; it receives summaries, not test results. Custom strategies must select a completely evaluated candidate without reducing incumbent validation accuracy, retain the incumbent on ties, and cannot be combined with token optimization or a resource policy.

After search, Evopt freezes the winner and evaluates baseline and winner on test in paired, alternating order. Test scores do not change selection. An unchanged winner is labeled an identity control rather than two independent observations. Reusing the same test set for subsequent human-guided tuning destroys its held-out status.

Results contain selected components, before/after changes, candidate history and lineage, normalized selection/experience settings, per-case evaluations, test accuracy, accounting entries, provenance, and completion or interruption status. Inspect `status` and `reason` before interpreting evidence.

`analyzeEvidence(result)`, `swe review`, and `experiment review` report paired wins/losses, improved and regressed case IDs, accuracy intervals, an exact McNemar comparison, token savings/per-case deltas, and observed settled costs. The token-delta interval is a descriptive fixed-seed bootstrap over task pairs, not proof of repeatable savings; it is `null` for identity controls or fewer than two pairs. One evaluation per case cannot quantify model rerun variance. See [methods and assumptions](CONFIGURATION.md#inspect-evidence-and-export-a-patch).

Contribution exports include this recomputable review and, for runs with the configuration contract, a guarded text patch. Validation recomputes statistics and edits from the evidence. Promotion eligibility checks accounting and regression rules; it is not a significance or authenticity certificate. See [evidence methods and assumptions](CONFIGURATION.md#inspect-evidence-and-export-a-patch). Reviewers reproduce a candidate before adopting it in their own application.

### Selection policy and training experience

For the default `objective: "tokens"`, the normalized policy is `{ kind: "quality-constrained-resource", metric: "tokens", ranking: "resource-first", minValidationAccuracy: 0, maxRegressions: 0 }`. The effective accuracy floor is the greater of baseline accuracy and the configured minimum. To add a stricter floor, configure:

```ts
optimization: {
  proposer, // The explicit proposer already configured for your adapter.
  selection: {
    kind: "quality-constrained-resource",
    metric: "tokens",
    ranking: "resource-first",
    minValidationAccuracy: 0.9,
    maxRegressions: 0,
  },
  experience: { maxObservations: 12, maxRejections: 5, maxCharacters: 16000 },
}
```

Resource-first selection requires strictly less of the chosen resource, its accuracy floor, and no more than the permitted baseline-case regressions. It may give up accuracy gains beyond the original baseline in exchange for fewer tokens; the original baseline remains the quality reference. A success on another case does not cancel a regression. Token optimization accepts only token/resource-first policies and cannot be combined with a custom strategy.

For explicit `objective: "accuracy"`, the default policy is `{ kind: "accuracy" }`. An explicit resource policy can instead choose `metric: "usd"` or `"tokens"` and `ranking: "accuracy-first"` or `"resource-first"`. Omitting `ranking` in such an explicit policy preserves the earlier accuracy-first behavior: resource use only breaks accuracy ties. Declare the objective and ranking together so the intended trade-off is clear.

USD uses settled evaluation charges; tokens count input plus output once. Cached input and reasoning are subsets, so they are not added twice. All validation cases, including failures, contribute to the totals. Proposal costs count toward the run ceiling, not a candidate's validation cost.

The experience settings above are defaults. They bound whole observations and rejection facts, with omitted counts when records do not fit. The experience cap does not bound the rest of the proposal request. Candidate lineage records the parent, attempt, proposal invocation, operator, and changed keys; history retains the corresponding proposal facts. Normalized settings are retained in `result.configuration` and the run fingerprint. See [limits and fields](CONFIGURATION.md#selection-and-training-experience).

### Adopt a reviewed configuration

After independently reviewing and reproducing a result, apply its exported patch to the original adapter:

```ts
import { applyConfigurationPatch, defineAgent } from "evopt";

const nextComponents = applyConfigurationPatch(agent, reviewedPatch);
const nextAgent = defineAgent({
  ...agent,
  version: "2", // Your application's next implementation/configuration version.
  components: nextComponents,
});
```

The helper verifies the original agent/version, baseline, mutable permissions, structure, and edit bounds; it returns new text for explicit adoption. Record the accepted patch and evidence with your next version. Evopt does not deploy it or maintain a promotion registry. Start a new run with a fresh holdout when earlier test results have informed the next experiment.

## USD accounting contract

The ceiling covers baseline evaluation, candidate proposals (including invalid proposals), candidate evaluations, and final holdout evaluation. Every paid model step, retry, and paid tool operation inside a callback must be included in its envelope and receipts. Local CPU time, storage, and other local compute are excluded.

A paid runner or proposer declares `accounting` with:

- `kind: "paid"`, a conservative `maxCostUSD` per invocation, an accounting `version`, and a description of how `enforcement` works.
- `limits` for model calls, input tokens, output tokens, paid tool calls, retries, and timeout. The adapter must enforce these for the whole invocation, including internal loops and SDK retries.
- Pinned `pricing` with a source, checked date, and USD input/output rates per million tokens; optional cache-read pricing describes observed discounts.

The constant envelope must be valid for every allowed component length and every dataset case. It must include paid tools and all possible retry costs, not a typical successful request. A timeout and AbortSignal alone cannot guarantee a monetary bound: providers may finish billing accepted requests after cancellation. Configure provider-side limits where available and keep adapter controls conservative.

Results return `usage: { complete: true, receipts: [...] }`. Each receipt identifies the request, provider, and model and reports `inputTokens`, `outputTokens`, and `cachedInputTokens`. Cached tokens are a subset of input tokens. Optional `reasoningTokens` are a subset of output tokens and are never charged twice. `extraCostUSD` covers non-token charges, including paid tools. Separate receipts cover separate billable operations, with applicable token pricing consistent with the adapter's pinned tariff. Free integrations return empty receipts and must perform no paid operations.

Accounting uses integer millionths of USD. Token charges are summed across an invocation's receipts and then rounded upward; non-token charges and reservations round upward, and the budget rounds downward. Sub-micro-unit and unsafe budgets are rejected. Before dispatch, Evopt durably reserves the invocation bound. Complete receipts settle it; uncertain billing leaves it reserved and stops the run. Envelope violations are recorded and stop further dispatch instead of being presented as successful budget compliance. If a callback declared free reports paid usage, the run is blocked from resuming: reported non-token charges are retained, but token costs cannot be determined without its missing tariff.

Before search, Evopt protects budget for both final test arms. Preflight fails without spending if baseline and final evaluation cannot fit. Search stops when its next work cannot fit while preserving that allowance. Unused completed-call reservations become available after settlement.

If `run.maxTokens` is configured, it independently caps total normalized input plus output tokens across target and proposer calls. Per-invocation input/output limits determine conservative token reservations, including protected final-evaluation bounds. Cached input and reasoning are counted within their parent categories once. Use the same ceiling on resume; USD and token ceilings do not substitute for each other.

If an integration violates its contract with malformed receipts, the interrupted result retains those receipts and its reason. `occupiedTokens` is omitted when no valid total can be computed; this is unknown usage, not zero. Such a run cannot resume automatically or be exported as completed evidence.

The ceiling is conditional on truthful, enforced adapter bounds and declared pricing. The ledger is not a provider invoice or a guarantee against misconfigured or malicious callbacks. Currency conversion, tariff changes during a run, and unmetered paid judges are unsupported.

## Durable runs and recovery

The four-property call creates a unique directory under `.evopt/runs/`. Choose a directory with `run: { directory: "./private-runs/category-v1" }`. Resume by passing the same adapter, dataset, budget, and directory with `run.resume: true`.

A lock prevents simultaneous writers. The store journals snapshots and atomically replaces its checkpoint; recovery can replay a newer complete journal record. Resume verifies a fingerprint and reuses completed matching evaluations. The frozen winner and test schedule persist across interruptions, so recovery cannot reopen selection.

Unresolved billing blocks resume and automatic retries. Stale locks also fail closed: inspect the owning process and evidence before removing a lock manually. Do not delete reservations, alter receipts, or raise a ceiling to make a run appear compliant. This version provides no automatic provider reconciliation. Changes to agent implementation, scoring behavior, tariffs, or proposer configuration require appropriate version changes and a new run when fingerprints differ.

Supply `run.signal` for cancellation and `run.includeTraces: true` to retain optional structured traces; traces are omitted by default. Components, task evidence, outputs, and identifiers may still contain sensitive information. Keep runs private and review evidence before sharing. Credentials are not part of saved configuration, but callbacks must not place secrets in outputs, traces, identifiers, or receipt fields.

## Optional OpenAI proposer

`createOpenAIProposer` from `evopt/openai` is an optional proposer, not an agent-framework integration. It takes an explicit configuration:

```ts
import { createOpenAIProposer } from "evopt/openai";

// Values below come from your reviewed application configuration.
const proposer = createOpenAIProposer<string, string>({
  apiKey: config.apiKey,
  model: config.pinnedModel,
  pricing: config.pinnedPricing,
  maxInputTokens: config.maxInputTokens,
  maxOutputTokens: config.maxOutputTokens,
  inputTokenOverhead: config.verifiedFramingTokenBound,
  timeoutMs: config.timeoutMs,
});
// Attach proposer as agent.optimization.proposer when defining the adapter.
```

`config` above is application-owned, not a global Evopt configuration. `pricing` includes `source`, `checkedAt`, `inputUSDPerMillion`, `outputUSDPerMillion`, and optional `cacheReadUSDPerMillion`. `inputTokenOverhead` must conservatively bound hidden message/schema framing for the pinned model. The implementation bounds serialized request bytes plus that overhead before dispatch. Choose a model that supports structured JSON-schema outputs and `max_completion_tokens`.

The core reads no credentials, selects no provider, and makes no requests on import. The proposer uses a single request without automatic retries or tools, forwards cancellation, and normalizes usage. Its `fetch` transport can be injected for tests. Attaching it and invoking `optimize` performs paid requests, even when the target agent is free; those requests share the total run ceiling.

## Related work and boundaries

GEPA, DSPy, Ax, and Opik provide prior work and tools relevant to prompt optimization and evaluation. Evopt does not claim a new optimization algorithm or to be the first framework-agnostic or TypeScript optimizer. Its focus is a small, auditable integration for existing TypeScript applications.

The repository provides a local experiment command helper around the library. It has no agent runtime, dashboard, SaaS accounts, distributed workers, arbitrary code search, graph rewriting, model training, or online production self-modification. The repository is not configured for publishing.
