# Evopt

Evopt helps existing TypeScript agents improve through bounded, evaluated changes to their prompts and tool descriptions. It returns a reviewable configuration patch with before/after results, uncertainty, costs, and regressions.

Your adapter runs your agent. Evopt has no agent runtime or dependency on a particular agent framework. Tool implementations, schemas, permissions, model settings, and graph topology are outside the candidate's edit scope. It does not generate or execute arbitrary code, train model weights, or modify production agents.

This repository is an unpublished working implementation. A Python package already uses the name `evopt`; this project makes no claim of package-name or trademark clearance.

Agent-aware declarations identify node roles, tool contracts, and handoffs so proposers can tailor text changes to the existing workflow. The same representation maps to an application's actual configuration through adapters. See [configuration and review](CONFIGURATION.md) for structured declarations and the OpenAI/Anthropic configuration maps.

## How Evopt evolves

Evopt grows through a repeatable contribution loop. Contributors supply experiments and explicitly authorized inference budgets; maintainers accumulate reproducible evidence and adopt reviewed improvements as versioned baselines.

```mermaid
flowchart LR
  A[Versioned baseline] --> B[Propose text edits using training cases]
  B --> C[Select on validation cases]
  C --> D[Freeze candidate]
  D --> E[Paired held-out evaluation]
  E --> F[Review gains, uncertainty, regressions, and cost]
  F --> G[Reproduce and explicitly adopt patch]
  G --> H[Next baseline and fresh holdout]
  H --> B
```

Within a run, the proposer uses training feedback, validation selects the candidate, and the final test compares the frozen candidate with its starting baseline. Across runs, a maintainer decides whether the evidence justifies a new baseline. A higher score alone is insufficient: inspect which cases changed, statistical uncertainty, settled costs, and reproduction results.

| What can evolve | How it happens |
| --- | --- |
| An agent's prompts and tool descriptions | Bounded proposals, labeled evaluation, and guarded configuration patches; implemented today |
| Shared baseline configurations | Contributors submit reviewed evidence; maintainers reproduce and explicitly adopt a new version |
| Framework and benchmark coverage | Contributors add tested adapters while preserving the common configuration and accounting contracts |
| Evopt's proposers and selection strategies | Replaceable interfaces exist today; better implementations are reviewed source contributions |
| Evopt optimizing its own proposal policy | Future work requiring dedicated experiments, comparable budgets, and independent holdouts |

Node roles, graph topology, tool schemas, and handoff contracts inform text proposals and remain fixed during optimization. Improvement is measured for the configured agent and task population; one successful experiment does not establish a universal prompt.

### Make an accepted result the next baseline

After reviewing and reproducing a completed run, export its guarded patch. Application code can adopt it explicitly:

```ts
import { applyConfigurationPatch, defineAgent } from "evopt";

// agent is the original configured adapter; reviewedPatch is its reviewed JSON patch.
const nextComponents = applyConfigurationPatch(agent, reviewedPatch);
const nextAgent = defineAgent({
  ...agent,
  version: "2", // Your application's next version identifier.
  components: nextComponents,
});
```

Application or Git history records the parent baseline, accepted patch digest, supporting submission, and new version. Evopt checks that the patch matches the original agent/version, baseline, allowlist, and structure; the caller owns adoption and versioning. There is no automatic promotion registry. Keep the original evidence intact, choose a fresh holdout once prior test results have informed decisions, and begin the next experiment in a new run directory. Resume is for recovering the original run, not starting another generation with a changed configuration.

## Run locally

Use Node.js 22 or newer:

```sh
npm install
npm test
npm run demo
```

Tests and the demo run offline without paid provider calls. Benchmark tests need Git with your user name and email configured; the Python evaluator integration test runs when Python is available. The demo creates an audit directory under `.evopt/runs/`.

## Contribute an optimization run

Start with [initial integrations](INTEGRATIONS.md) to choose a contributor assistant or a metered target/proposer provider. Run `npm run experiment -- integrations` to inspect the support matrix. Contributor presets include Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Aider, Cline, and Roo Code; model API integrations include OpenAI, Anthropic Claude, Gemini, and explicitly configured OpenAI-compatible endpoints.

Contributors can supply their own explicitly approved token budget, optimize an existing agent's declared text, and submit evidence for review. The workflow follows OPS-GA's local experiment model while using Evopt's general-agent adapter:

```sh
npm run experiment -- init --out .evopt/experiment.mjs
npm run experiment -- check --config .evopt/experiment.mjs --budget 10
npm run experiment -- run --config .evopt/experiment.mjs --budget 10 --out .evopt/runs/first
npm run experiment -- status --run .evopt/runs/first
npm run experiment -- review --run .evopt/runs/first
# After reviewing the candidate text, identifiers, and receipts for sharing:
npm run experiment -- patch --run .evopt/runs/first --out .evopt/first.patch.json --reviewed
npm run experiment -- export --run .evopt/runs/first --out contributions/first.json --id first --summary "Offline workflow demonstration" --reviewed
npm run experiment -- validate --file contributions/first.json
```

The generated experiment is free and synthetic. Replace its adapter and dataset with a reviewed real experiment to contribute meaningful evidence. Paid execution additionally requires `--allow-paid`; the budget covers both target evaluations and proposals. No command publishes a submission or changes shared defaults. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution loop and [experiments](experiments/README.md) for experiment configuration, including the optional paid example.

To delegate a run to your own coding assistant, give it the experiment and an explicit instruction such as: “Read CONTRIBUTING.md, check this experiment and its pinned prices, then run it with a total maximum of USD X. Stop on uncertain billing. Prepare a review package; do not publish it.” Replace X yourself. Merely reading this example grants no spending authorization.

Useful contributions include better agent text, a reproducible experiment, a representative task suite, an adapter with enforced accounting, a clearer proposer, or a stronger selection strategy. Record the hypothesis before examining test results and preserve unsuccessful candidates and regressions alongside improvements. The [contributor guide](CONTRIBUTING.md) explains preparation and review; [shareable experiments](experiments/README.md) describes what to commit.

Repository structure:

```text
src/             General-agent library, accounting, persistence, evidence validation
bin/             Thin local experiment and benchmark command helpers
experiments/     SWE-bench and other shareable experiment definitions
benchmarks/      SWE source import, fresh workspaces, official harness, benchmark catalog
examples/        Minimal library API examples
contributions/   Reviewed portable submissions and contribution guidance
test/            Offline core, accounting, workflow, and evidence tests
.evopt/          Ignored private configurations and run evidence
```

## Current capabilities

| Capability | Current support |
| --- | --- |
| Portable agent configuration | Named text, explicit mutable owners/limits, nodes, roles, tool schemas, and handoffs |
| Agent execution | Developer-supplied fresh, metered `run` adapter; generic input/output types preserved |
| Framework configuration mapping | OpenAI Chat Completions and Anthropic Messages prompt/tool definitions |
| Candidate proposers | OpenAI, Anthropic, Gemini, explicitly configured compatible endpoints, and deterministic offline fixtures |
| Software-engineering evaluation | SWE-bench, Lite, and Verified through a compatible pinned local official harness |
| Reviewable evidence | Paired outcomes, confidence intervals, regression IDs, observed costs, and guarded patches |
| Contribution and recovery | Local CLI, private durable runs, reviewed exports, validation, and matching-run resume |

Configuration maps do not supply a coding-agent runtime. Contributor-assistant presets help people operate the repository; they do not automatically turn each assistant into an evaluated target. Package tests use offline providers and authored evaluator fixtures. A passing test suite establishes integration behavior, not measured improvement on a real benchmark.

## Benchmarks

The [benchmarks directory](benchmarks/README.md) follows back-ops-ga's **SWE-bench** workflow: import pinned tasks, give an existing coding agent a fresh repository at the task's base commit, collect its patch, and evaluate it with the pinned official Docker harness. SWE-bench, SWE-bench Lite, and SWE-bench Verified use the same adapter. Evopt optimizes declared prompts and tool descriptions; your existing agent owns its tools, execution limits, and usage receipts.

```sh
npm run benchmark -- list
```

Follow [SWE-bench preparation](benchmarks/README.md#prepare-swe-bench) and the [SWE-bench experiment](experiments/swe-bench/README.md) to connect your agent to the USD-budgeted optimization and contribution workflow. Import a reviewed local dataset export and choose explicit disjoint train/validation/test instance IDs. Dataset hashes, manifest hashes, evaluator revisions, metric, and split policy accompany the evidence. Gold patches and hidden tests stay in private evaluator data and never enter target inputs.

Provision repositories, Python dependencies, and Docker separately. Preparation and checks make no model calls; evaluation executes repository tests through the official harness and may need separately provisioned images and dependencies. Local evaluation compute and storage are outside the inference USD ceiling.

The benchmark catalog also assesses FrontierCode, Terminal-Bench, and SWE-Atlas-QnA-AA; see [benchmark research](benchmarks/RESEARCH.md) for source availability and grading requirements. Custom optimization subsets are not official leaderboard submissions. Tests use authored fixtures and local mock evaluators, which do not establish public-benchmark performance.

## Explicit setup, small optimization call

The package root exports `defineAgent`, `optimize`, `exactMatch`, `createOfflineProposer`, `accuracyStrategy`, and public TypeScript types. This complete example needs no credentials or global SDK configuration:

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

Only `objective: "accuracy"` is initially supported. Invalid budgets, missing mutable components, malformed datasets, unsupported objectives, and incomplete paid accounting settings fail before provider dispatch.

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

The default strategy is bounded mutation and selection, with ten proposal attempts unless `optimization.maxAttempts` changes it. Execution is sequential, with one evaluation per case and candidate. The proposer is separate from the runner and receives the current mutable components, their specifications, and training feedback only. Validation examples and test labels never enter that feedback.

Each proposal is a patch containing allowlisted component keys. Invalid, oversized, empty, and duplicate proposals are recorded without candidate evaluation. Baseline and valid candidates receive train and validation evaluations. Selection uses complete validation accuracy and retains the incumbent on ties. An optional `optimization.strategy` can replace selection through the exported `SearchStrategy` interface; it receives score summaries, not test results. Custom strategies must select a completely evaluated candidate without reducing validation accuracy; ties still retain the incumbent.

After search, Evopt freezes the winner and evaluates baseline and winner on test in paired, alternating order. Test scores do not change selection. An unchanged winner is labeled an identity control rather than two independent observations. Reusing the same test set for subsequent human-guided tuning destroys its held-out status.

Results contain selected components, before/after changes, candidate history, per-case evaluations, test accuracy, accounting entries, provenance, and completion or interruption status. Inspect `status` and `reason` before interpreting evidence.

`analyzeEvidence(result)` and `experiment review` report paired wins/losses, improved and regressed case IDs, Wilson accuracy intervals, a conservative paired accuracy-difference interval, an exact McNemar comparison, and observed settled costs. A one-case gain can coexist with a wide interval; one evaluation per case cannot quantify repeated-model variance. Identity controls reuse the same observations once and make no independent comparison claim.

Contribution exports include this recomputable review and, for runs with the configuration contract, a guarded text patch. Validation recomputes statistics and edits from the evidence. Promotion eligibility checks accounting and regression rules; it is not a significance or authenticity certificate. See [evidence methods and assumptions](CONFIGURATION.md#inspect-evidence-and-export-a-patch). Reviewers reproduce a candidate before adopting it in their own application.

## Development path

The next steps should strengthen evidence and contributor reuse before broadening the runtime surface. These are development priorities, not implemented capabilities or authorization to spend money.

1. **Establish reproducible SWE baselines.** Run explicitly funded experiments through existing coding-agent adapters, publish reviewed per-instance evidence, and have another contributor reproduce it. Preserve source/evaluator pins, model settings, parent baseline, costs, and regression cases. This turns the tested integration into an empirical optimization result.
2. **Measure stability across repeated trials.** Add explicit trial counts, paired schedules, and durable trial identities. Reserve all trials in the same budget and report variation across cases and model executions. Current evaluation makes one call per case and candidate.
3. **Meter graders through the same ledger.** Add a grader interface with enforced bounds, normalized receipts, resumable votes, and failure handling before supporting paid model judges. The current local scorer must remain free of paid calls.
4. **Expand SWE evaluation deliberately.** Add a Terminal-Bench adapter for its Harbor environments and verifier/integrity workflow. Add SWE-Atlas-QnA-AA after metered rubric judging is available. FrontierCode requires authorized task and grader access. Each adapter needs its own tested protocol; see [benchmark research](benchmarks/RESEARCH.md).
5. **Evaluate improvements to Evopt itself.** Make proposer instruction profiles explicitly configurable and versioned, then compare challenger proposers or selectors across several fixed agents and task suites. Match total USD ceilings, account for every nested call, compare invalid-edit rates, gains, regressions, and cost, and use independent holdouts. Today these changes are ordinary reviewed source contributions; Evopt does not run this optimization automatically.
6. **Grow adapters from real applications.** Add an SDK bridge when it demonstrates correct component mapping, fresh sessions, cancellation, enforced accounting, and reproducible evidence. Keep integration-specific behavior in its adapter.

The success criterion is a reusable configuration or optimization change that another contributor can reproduce, assess, and adopt with its trade-offs visible. Token spending is an experimental resource; evidence determines whether the project learned anything useful.

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

GEPA, DSPy, Ax, Opik, and OPS-GA provide prior work and tools relevant to prompt optimization and evaluation. Evopt does not claim a new optimization algorithm or to be the first framework-agnostic or TypeScript optimizer. It borrows bounded search, conservative accounting, and durable evidence patterns from OPS-GA, with a small integration boundary for existing TypeScript applications.

The repository provides a local experiment command helper around the library. It has no agent runtime, dashboard, SaaS accounts, distributed workers, arbitrary code search, graph rewriting, model training, or online production self-modification. The repository is not configured for publishing.
