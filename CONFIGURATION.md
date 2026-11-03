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

Pass these fields to `defineAgent`, together with its identity/version, fresh `run` callback, accounting envelope, and explicit proposer. `createSWEAgent` accepts the same fields and prepares a fresh base-commit workspace. The four-property `optimize({ agent, dataset, objective: "accuracy", budget })` call stays the same.

Every mutable field in a structured declaration needs the correct kind and target. Validation rejects missing owners, duplicate ownership, unknown tool/handoff references, callbacks in metadata, and invalid text limits before invocation. Existing flat adapters remain usable.

The proposer receives mutable text, training feedback, and a frozen snapshot of public roles/contracts/topology. Immutable prompts appear as key references without their contents. OpenAI, Anthropic, and Gemini proposers include that structure in their requests. Validation and test labels stay outside proposals. The target still receives only its input, components, and run context.

## Map to existing frameworks

`mapOpenAIChatConfiguration(configuration, nodeId, components)` returns ordered system text and Chat Completions function-tool definitions. `mapAnthropicConfiguration` returns Messages `system` and `tools` fields. Both preserve exact input schemas, include only the node's tools, and reject unsupported names or edits to immutable text. They require explicit object input schemas rather than inventing contracts.

Use these values inside the application's fresh, metered invocation. Its existing tool loop and graph enforce permissions, output schemas, handoffs, and cancellation. The helpers perform no provider requests. Formats follow [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

## Inspect evidence and export a patch

```sh
npm run experiment -- review --run .evopt/runs/swe-1
npm run experiment -- patch --run .evopt/runs/swe-1 --out .evopt/swe-patch.json --reviewed
```

`analyzeEvidence(result)` computes the same review in application code: paired held-out outcomes, improved/regressed case IDs, Wilson 95% intervals for each arm, a conservative paired Hoeffding 95% interval for the accuracy difference, and an exact two-sided McNemar test. An identity control reuses its observations once and has no independent comparison or significance result.

Intervals assume independent, representative cases. One run per case cannot measure repeated-model variance; related tasks can violate independence. Small samples may show an observed gain while remaining inconclusive. Final test cases stay excluded from selection; subsequent tuning needs a fresh holdout.

Costs use settled ledger charges matched to evaluation IDs. The review separates baseline/candidate held-out costs, proposals, other evaluations, and the total run. Cost per successful case includes failed-case costs and is `null` for zero successes. These are observed costs under pinned prices, not future production costs or local Docker expenses.

Contribution export includes the recomputable review, configuration contract, and patch. Validation recomputes statistics and edits from per-case evidence and the ledger. Preserve experiment definitions, source hashes, evaluator pins, environment versions, and private reports for reproduction. Report regression IDs and rerun those cases for later configurations. Exported statistics and hashes do not authenticate results.

`createConfigurationPatch(result)` creates portable JSON containing changed text and its role/target. `applyConfigurationPatch(agent, patch)` checks identity/version, baseline, allowlist and structure hashes, before-values, and lengths, then returns new components for explicit adoption. Older artifacts without the original configuration contract can be analyzed but cannot produce a guarded patch.
