# Initial integrations

Evopt distinguishes the assistant a contributor uses from the target an experiment evaluates. Choosing Cursor as your contributor assistant does not turn Cursor into an OpenAI API client or imply that its subscription allowance is a USD optimization budget.

```sh
npm run experiment -- integrations
```

## Contributor assistants

Portable contributor briefs are available for OpenAI Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Aider, Cline, and Roo Code. These briefs work through the existing repository commands; they do not launch the assistant, read its credentials, or install a plugin.

```sh
npm run experiment -- onboard --assistant cursor --out .evopt/cursor-brief.md
npm run experiment -- onboard --assistant claude-code --out .evopt/claude-brief.md
npm run experiment -- onboard --assistant codex --out .evopt/codex-brief.md
```

Open the repository in your chosen assistant and give it the generated brief. Supply your own experiment and explicit spending ceiling when authorizing a run. `openai` aliases `codex`, `claude` aliases `claude-code`, `copilot` aliases `github-copilot`, and `gemini` aliases `gemini-cli` **in this assistant selector only**. Brief creation is offline. Assistant conversation costs outside Evopt are not metered by Evopt and are not covered by its run ceiling.

## Metered model API targets and proposers

| Provider option | Package import | Target runner | Proposer |
| --- | --- | --- | --- |
| `openai` | `evopt/openai` | `createOpenAITextRunner` | `createOpenAIProposer` |
| `anthropic` / `claude` | `evopt/anthropic` | `createAnthropicTextRunner` | `createAnthropicProposer` |
| `gemini` / `google` | `evopt/gemini` | `createGeminiTextRunner` | `createGeminiProposer` |
| `openai-compatible` | `evopt/openai` | `createOpenAICompatibleTextRunner` | `createOpenAICompatibleProposer` |
| `offline` | `evopt` | Generated deterministic fixture | `createOfflineProposer` |

These are real API implementations with mocked transport tests. Their built-in targets are single-request **text** runners with string input/output and a selected system-prompt component (`promptKey`, default `systemPrompt`). They do not execute tools or recreate a coding-agent runtime. Tool-description optimization in an existing tool-using application still uses its explicitly configured `defineAgent` adapter.

All paid factories require explicit `apiKey`, `model`, `pricing`, `maxInputTokens`, `maxOutputTokens`, `inputTokenOverhead`, and `timeoutMs`. Pin an applicable model and tariff; do not assume that similarly named models or API-compatible providers share prices. The reviewed framing bound must cover provider-added message/schema tokens for the selected model. Requests are bounded before dispatch, have an output cap, use fresh messages, forward cancellation, and do not retry or call tools. Missing billing information stops the run rather than becoming zero-cost usage.

Prepare a private settings JSON using [the settings template](experiments/openai-settings.example.json). Replace every required placeholder with reviewed values; include `maxAttempts` for generated experiments. No command chooses a model, tariff, key, or budget for you.

```sh
npm run experiment -- init --provider claude --settings .evopt/provider-settings.json --out .evopt/claude-experiment.mjs
npm run experiment -- check --config .evopt/claude-experiment.mjs --budget 10
# Only after the person paying explicitly authorizes that ceiling:
npm run experiment -- run --config .evopt/claude-experiment.mjs --budget 10 --out .evopt/runs/claude-1 --allow-paid
```

The same commands accept `openai`, `gemini`, and `openai-compatible`. `init` writes a module that references your explicitly selected settings path; it neither reads credentials nor sends requests. The generated dataset is a tiny public wiring smoke test, not a representative benchmark. Replace it with suitable labeled tasks and a fresh holdout for meaningful contributions. Generated modules import this checkout by absolute path; share a portable reviewed experiment definition rather than private paths.

OpenAI-compatible settings additionally require `baseURL` (an explicit HTTPS API base such as a provider's documented `/v1` endpoint) and `provider` (a stable identifier). Compatibility requires support for `max_completion_tokens`, the submitted request fields, JSON-schema structured outputs for proposals, complete token usage, and the documented cached/reasoning-token semantics. A compatible URL alone does not establish that contract. Unsupported responses fail closed; there is no fallback to another provider or a guessed receipt.

The Anthropic integration uses the Messages API, including structured output for proposals. Its normalized total input includes uncached input plus cache reads. It does not request cache writes and rejects unexpected cache-write or server-tool charges rather than mispricing them. Its selected model must match the returned model. See the [Messages API](https://platform.claude.com/docs/en/api/messages/create) and [cache accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The Gemini integration uses the Interactions API with a combined output/thinking token cap and a fresh, non-stored interaction. It includes thought tokens in normalized output usage and requires complete usage metadata. See the [Interactions API](https://aistudio.google.com/api-reference/interactions-api) and [thinking token limits](https://aistudio.google.com/docs/thinking#token-limits).

You can mix a target provider with a different proposer, each with its own explicit settings:

```ts
import { defineAgent } from 'evopt';
import { createOpenAITextRunner } from 'evopt/openai';
import { createAnthropicProposer } from 'evopt/anthropic';

const agent = defineAgent<string, string>({
  id: 'my-text-agent', version: '1',
  components: { systemPrompt: 'Your application instructions.' },
  mutable: { systemPrompt: { role: 'Application instructions', maxLength: 2000 } },
  ...createOpenAITextRunner(targetSettings),
  optimization: { proposer: createAnthropicProposer<string, string>(proposerSettings) },
});
```

`targetSettings` and `proposerSettings` are your explicitly supplied application configuration. Both providers consume the same `optimize` run budget.

## Full agent SDKs and frameworks

OpenAI Agents SDK, Claude Agent SDK, Codex SDK, Cursor SDK, LangGraph, Vercel AI SDK, and Mastra can be connected through `defineAgent`, but **turnkey, automatically metered target adapters are not shipped for them**. The integration listing labels them `custom-adapter-required`, not supported built-ins.

An application adapter must wire the editable text into the actual runtime, create fresh state, return complete normalized receipts, and enforce an invocation envelope covering every internal model step, retry, and paid tool. Wrapping an SDK's final output or setting a timeout is insufficient. Keep tool implementations, permissions, topology, and evaluator code outside the mutable allowlist.

This distinction matters for the named coding assistants:

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) can control local agents, but an Evopt adapter still needs independently verified spending enforcement and isolation.
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/agent-loop#budget-headroom) checks its budget after responses and may overshoot. `maxBudgetUsd` alone does not meet Evopt's reservation contract.
- [Cursor SDK](https://cursor.com/docs/sdk/typescript) exposes agent execution and usage. Its documented usage reports and [account spending limits](https://cursor.com/help/account-and-billing/spend-limits) do not establish the pre-dispatch invocation bound Evopt requires. Cursor contributor onboarding is available; automatic Cursor-target optimization remains a custom integration.

Contribute a framework adapter with a pinned runtime version, explicit enforcement, usage reconciliation, isolation tests, and an offline transport fixture. Do not silently classify subscription-backed sessions as free or claim full runtime support from a preset name.
