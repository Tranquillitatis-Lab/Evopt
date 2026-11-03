# Agent-aware configuration and review

Evopt describes editable text separately from an agent's structure. Each editable field declares its purpose, length limit, kind, and owning node or tool. Nodes expose their roles and tools; tool contracts and handoffs give proposals context. The application's adapter maps those named fields to its framework configuration.

Graph topology, tool schemas, implementations, permissions, and handoff contracts are immutable. Optimization produces edits to the declared prompts and tool descriptions.

## Declare the configuration

```ts
import { type AgentTextConfiguration } from "evopt";

const configuration = {
  components: {
    coderPrompt: "Repair the issue and return a patch.",
    reviewerPrompt: "Review the patch against the issue.",
    lookupDescription: "Read a source file by its repository path.",
  },
  mutable: {
    coderPrompt: {
      role: "Guide the repair process", maxLength: 4000,
      kind: "prompt", target: { type: "node", id: "coder" },
    },
    lookupDescription: {
      role: "Explain source-file lookup", maxLength: 800,
      kind: "tool-description", target: { type: "tool", id: "lookup" },
    },
  },
  structure: {
    version: 1,
    nodes: [
      { id: "coder", role: "Implement a repair", promptKeys: ["coderPrompt"], toolIds: ["lookup"] },
      { id: "reviewer", role: "Review the repair", promptKeys: ["reviewerPrompt"], toolIds: [] },
    ],
    tools: [{
      id: "lookup", descriptionKey: "lookupDescription",
      inputSchema: {
        type: "object", properties: { path: { type: "string" } },
        required: ["path"], additionalProperties: false,
      },
      outputSchema: { type: "string" },
      constraints: ["Read only inside the task repository"],
    }],
    handoffs: [{
      id: "review-repair", from: "coder", to: "reviewer",
      description: "Submit the completed repair for review",
      contract: { payload: "patch", requires: ["issue-id", "patch"] },
    }],
  },
} satisfies AgentTextConfiguration;
```

Pass these fields to `defineAgent`, together with its identity/version, fresh `run` callback, accounting envelope, and explicit proposer. `createSWEAgent` accepts the same fields and prepares a fresh base-commit workspace. Use `optimize({ agent, dataset, budget })` for the default tokens objective, or explicitly pass `objective: "tokens"` or `"accuracy"`.

Every mutable field in a structured declaration needs the correct kind and target. Validation rejects missing owners, duplicate ownership, unknown tool/handoff references, callbacks in metadata, and invalid text limits before invocation. Existing flat adapters remain usable.

The proposer receives mutable text, training feedback, training experience, its selection policy, and a frozen snapshot of public roles/contracts/topology. Immutable prompts appear as key references without their contents. OpenAI, Anthropic, and Gemini proposers include this context in their requests. Validation and test labels stay outside proposals. The target still receives only its input, components, and run context.

## Selection and training experience

The default objective is `"tokens"`: select strictly fewer validation tokens while maintaining at least baseline validation accuracy and allowing zero regressions on baseline-passing cases. The effective accuracy floor is the greater of baseline accuracy and the configured minimum. Set an optional policy in `agent.optimization` to require a stronger floor:

```ts
optimization: {
  proposer, // Your explicitly configured, metered proposer.
  maxAttempts: 10,
  selection: {
    kind: "quality-constrained-resource",
    metric: "tokens",
    ranking: "resource-first",
    minValidationAccuracy: 0.9,
    maxRegressions: 0,
  },
  experience: {
    maxObservations: 12,
    maxRejections: 5,
    maxCharacters: 16000,
  },
}
```

Without an explicit policy, tokens mode uses the settings above with `minValidationAccuracy: 0`. The original baseline's accuracy still applies as a floor. A candidate must use strictly fewer tokens than the incumbent and meet the baseline-quality guards. More accuracy alone cannot win; equal-token candidates retain the incumbent. Resource-first selection may give up gains beyond baseline accuracy for fewer tokens, so inspect per-case results. The regression guard counts individual baseline-passing cases; solving another case does not cancel a regression. Test results never determine selection.

Explicit `objective: "accuracy"` keeps the earlier default `{ kind: "accuracy" }`: higher validation accuracy wins and ties retain the incumbent. In accuracy mode, an explicit `quality-constrained-resource` policy may use USD or tokens and either ranking. `ranking: "accuracy-first"` (also the meaning of an omitted ranking in an explicit policy) uses resource cost only to break accuracy ties; `"resource-first"` requires a strict resource reduction after quality guards. Tokens mode requires `metric: "tokens"` and `ranking: "resource-first"`; incompatible settings fail before invocation.

The resource totals include all validation cases, including failures. `usd` uses the corresponding settled evaluation charges; `tokens` sums input and output tokens, with cached input and reasoning treated as subsets rather than added twice. This distinction matters when caching makes a longer invocation cheaper. Proposal costs remain in the total optimization-run budget, but are not attributed to a candidate's validation cost. A custom selection strategy is supported only with the accuracy objective and accuracy policy; incompatible combinations fail before invocation.

Each proposal receives `experience`, a deterministic projection of completed training evaluations across candidates and earlier proposal rejections. Observations include candidate/case identity, baseline and candidate outcomes, settled cost and token counts, changed mutable text, and available lineage. They contain no validation/test observations, task inputs, expected answers, or historical output bodies. Current-incumbent labeled training feedback remains a separate `feedback` field. The target agent receives neither field.

The default limits are 12 observations, 5 rejection facts, and 16,000 serialized characters. `maxObservations` may be 0–100, `maxRejections` 0–25, and `maxCharacters` 512–128,000. Entries are bounded as whole records; omitted counts disclose truncation. These limits bound the experience projection, not the entire provider prompt: mutable components, current training feedback, and structure also consume context and must fit the configured accounting envelope.

Each evaluated candidate records `lineage: { parentId, attempt, operator: "proposer-text-patch", changedKeys, proposalId }`. Proposal history retains the corresponding parent, invocation, and changed-field facts, including rejected attempts. The normalized selection and experience settings appear in `result.configuration` and participate in the run fingerprint. Matching-run resume preserves the recorded candidate, lineage, and settled invocations; changing settings requires a new run.

This foundation learns from evidence within a run. It does not tune Evopt's own proposer prompt, create an autonomous baseline registry, repeat cases to measure model variance, or attest which framework tools an agent actually used. Those require additional experiments and implementation.

## Map to existing frameworks

`mapOpenAIChatConfiguration(configuration, nodeId, components)` returns ordered system text and Chat Completions function-tool definitions. `mapAnthropicConfiguration` returns Messages `system` and `tools` fields. Both preserve exact input schemas, include only the node's tools, and reject unsupported names or edits to immutable text. They require explicit object input schemas rather than inventing contracts.

Use these values inside the application's fresh, metered invocation. Its existing tool loop and graph enforce permissions, output schemas, handoffs, and cancellation. The helpers perform no provider requests. Formats follow [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

## Inspect evidence and export a patch

```sh
npm run experiment -- review --run .evopt/runs/swe-1
npm run experiment -- patch --run .evopt/runs/swe-1 --out .evopt/swe-patch.json --reviewed
```

`analyzeEvidence(result)` computes the same review in application code: paired held-out outcomes, improved/regressed case IDs, Wilson 95% intervals for each arm, a conservative paired Hoeffding 95% interval for the accuracy difference, and an exact two-sided McNemar test. An identity control reuses its observations once and has no independent comparison or significance result.

The review's `tokens` section reports held-out totals, savings, per-case deltas, proposal usage, and total run usage. A per-case delta is candidate minus baseline: negative means fewer tokens. `deltaInterval95` is a descriptive interval for the mean per-case token delta, formed from 1,000 fixed-seed resamples of task pairs. It is `null` for an identity control or fewer than two pairs. It does not estimate model rerun variance or prove future savings; `savingsFraction` is also `null` when baseline tokens are zero.

Intervals assume independent, representative cases. One run per case cannot measure repeated-model variance; related tasks can violate independence. Small samples may show an observed gain while remaining inconclusive. Final test cases stay excluded from selection; subsequent tuning needs a fresh holdout.

Costs use settled ledger charges matched to evaluation IDs. The review separates baseline/candidate held-out costs, proposals, other evaluations, and the total run. Cost per successful case includes failed-case costs and is `null` for zero successes. These are observed costs under pinned prices, not future production costs or local Docker expenses.

Contribution export includes the recomputable review, configuration contract, selection policy, lineage, and patch. Validation reconstructs selection and checks lineage against proposal history and settled invocations, in addition to recomputing statistics and edits from per-case evidence and the ledger. Recalculating an artifact's digest does not make contradictory evidence valid. Preserve experiment definitions, source hashes, evaluator pins, environment versions, and private reports for reproduction. Report regression IDs and rerun those cases for later configurations. Exported statistics and hashes do not authenticate results.

`createConfigurationPatch(result)` creates portable JSON containing changed text and its role/target. `applyConfigurationPatch(agent, patch)` checks identity/version, baseline, allowlist and structure hashes, before-values, and lengths, then returns new components for explicit adoption. Older artifacts without the original configuration contract can be analyzed but cannot produce a guarded patch.
