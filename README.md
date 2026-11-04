# Evopt

Evopt searches for better prompts and tool descriptions for an existing agent. You bring the agent, a labeled dataset, and a spending limit; Evopt tests bounded changes and records the evidence for review. It aims to reduce token use while preserving task performance.

## Try it offline

Node.js 22 or later is required. Install dependencies and build with `npm install` and `npm run build`. The example uses synthetic tasks and makes no model calls.

```sh
node dist/bin/evopt.js doctor --config examples/offline.json
node dist/bin/evopt.js preflight --config examples/offline.json
node dist/bin/evopt.js run --config examples/offline.json
node dist/bin/evopt.js validate --config examples/offline.json
node dist/bin/evopt.js export --config examples/offline.json --lane operations --out result.json
node dist/bin/evopt.js verify --file result.json
```

Choose a fresh output directory for each optimization run. `run` uses training and validation tasks; `validate` freezes search and evaluates the held-out test tasks. Review the exported patch and evidence before applying a change.

`verify` checks the exported file's internal consistency; it cannot authenticate its origin or prove that a benchmark was actually run. Review the source evidence and reproduce a result before accepting it.

## Connect your agent

Start with `examples/offline.json`. Set `agentModule` to a trusted local module exporting `agent`, and `datasetModule` to one exporting `dataset`. Give the run a private output path, a USD ceiling and optional token ceiling. Provide isolated train, validation and test partitions and a scoring function; keep labels out of the agent's inputs.

The adapter declares its initial components, which component keys can change, and their length limits. Each call creates fresh agent state, uses the supplied components and reports normalized usage. Paid adapters must enforce the declared per-call cost and token limits. The proposer is configured explicitly; there is no paid default.

Use `createOfflineProposer` for local tests. OpenAI, Claude, Gemini and Cursor adapters are available from `evopt/adapters`:

```ts
import { createClaudeProposer, createOpenAIProposer, createGeminiProposer } from 'evopt/adapters';
import { claudePricing, openaiPricing, geminiPricing } from './my-pricing.js';

// Supply your own current, pinned prices and limits.
const limits = { maxInputTokens: 10_000, maxOutputTokens: 1_000,
  inputTokenOverhead: 500, timeoutMs: 60_000 };
const proposer = createClaudeProposer({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'your-pinned-claude-model',
  pricing: claudePricing,
  cacheWriteUSDPerMillion: claudePricing.cacheWriteUSDPerMillion,
  ...limits,
});
```

For OpenAI, replace the proposer with:

```ts
const proposer = createOpenAIProposer({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'your-pinned-openai-model',
  pricing: openaiPricing,
  ...limits,
});
```

For Gemini, use your Google AI API key and pinned model:

```ts
const proposer = createGeminiProposer({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'your-pinned-gemini-model',
  pricing: geminiPricing,
  ...limits,
});
```

Configure the proposer under `agent.optimization.proposer`. The model, prices, limits and credentials are explicit, and no provider call happens during setup. The proposer receives training feedback, so only use data you may send to that provider.

For Gemini, output accounting includes both the response and thinking tokens. The proposer relies on Google's documented [output-token limit](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max-output-tokens); if a response exceeds the declared envelope, Evopt records the usage and stops the run.

Each pricing object needs `source`, `checkedAt`, `inputUSDPerMillion`, `outputUSDPerMillion`, and optionally `cacheReadUSDPerMillion`. Claude also needs a conservative `cacheWriteUSDPerMillion`. Check [OpenAI pricing](https://platform.openai.com/pricing), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), or [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), including any rate modifiers, before setting your ceiling.

To evaluate an existing OpenAI, Claude or Gemini agent, use `defineOpenAIAgent`, `defineClaudeAgent` or `defineGeminiAgent` from the same entry point. Supply a callback that creates fresh agent state, applies the declared components, enforces the supplied limits, and returns the output plus every billed provider response. The adapter converts supported usage into Evopt receipts; it does not launch an agent or configure an SDK. Target-agent adapters currently require one pinned model, complete usage and no paid tools. Gemini supports text-only requests without explicit cache storage; Claude does not support cache creation. See the [provider example](examples/provider-agent.ts) and [Gemini example](examples/gemini-agent.ts) for the callback shapes.

For Cursor, `defineCursorAgent` wraps an existing agent and `createCursorProposer` wraps a proposal callback. Provide a pinned model, conservative pricing including cache writes and Cursor fees, and a separately enforced per-invocation boundary. Each callback must create fresh state and return complete, settled, run-scoped usage and cost from Cursor; see [the Cursor example](examples/cursor-agent.ts). Missing or delayed billing information stops the run. The adapter does not start Cursor or enforce its spending limit: the documented SDK does not provide Evopt with a per-run USD ceiling. Cursor usage included in a subscription is not treated as an unlimited Evopt budget. See [Cursor's SDK usage documentation](https://cursor.com/docs/sdk/typescript#token-usage).

Set the accounting envelope above the independently enforced boundary to allow for microdollar rounding; it must also cover the configured input, output and cache-write limits. If Cursor reports both raw and charged cost as zero, Evopt conservatively accounts for the full boundary; that amount is an upper bound, not an invoice.

```ts
import { defineCursorAgent } from 'evopt/adapters';
import { cursorSettings, runBoundedCursor } from './my-cursor-integration.js';

const agent = defineCursorAgent({ ...cursorSettings, run: runBoundedCursor });
```

Adapters can also describe agent nodes, roles, tool contracts and handoffs as read-only `structure` metadata. Proposers use that context when suggesting text; Evopt does not change the structure or contracts.

The four files in `lanes/` define the operations, interface, PTC and discovery searches. Their gene names must match declared mutable component keys, with the same initial text. Lane scope and protected policy are fixed context for proposals; your adapter must explicitly include any applicable policy in the agent's immutable configuration. Review each lane against your agent's actual tools before running it.

```sh
node dist/bin/evopt.js init --out evopt.local.json --budget-usd 10
node dist/bin/evopt.js doctor --config evopt.local.json
node dist/bin/evopt.js preflight --config evopt.local.json
node dist/bin/evopt.js run --config evopt.local.json --lane operations
node dist/bin/evopt.js status --config evopt.local.json
```

Edit the starter config to use your own adapter and dataset before a real run. USD is the total run ceiling, shared by search and validation, not an iteration count. Keep credentials and private run output out of submissions.

To contribute an improvement or build on a reviewed result, follow the [contribution guide](external-pr/README.md) and its submission template.

## SWE-bench

Prepare an official local dataset export and local repository checkouts. Write an import settings JSON containing `dataset`, a pinned 40-character dataset `revision`, `repositoryRoot`, and explicit disjoint instance IDs in `groups.train`, `groups.gate` and `groups.test`. Then create a manifest without inference:

```sh
node dist/bin/evopt.js benchmark --input swe-export.json --settings swe-settings.json --out swe-manifest.json
```

In your dataset module, use `createSWEDataset` from `evopt/benchmarks` with the manifest and your pinned local Python/Docker evaluator settings. Wrap your agent with `createSWEAgent` to give each task a fresh checkout. Keep benchmark source and grading reports private. The offline example is only a workflow check; it is not SWE-bench evidence. The integration has been tested with a local fake evaluator; a real SWE-bench run requires a compatible pinned evaluator, Docker and its benchmark assets.

You can also use the TypeScript API with your configured adapter and dataset:

```ts
import { optimize } from 'evopt';
import { agent } from './my-agent.js';
import { dataset } from './my-dataset.js';

const result = await optimize({ agent, dataset, objective: 'tokens', budget: 10 });
```

Use `defineAgent` to declare an adapter. Evopt changes only declared prompt and tool-description text; it does not modify agent code, graph topology, or model weights.
