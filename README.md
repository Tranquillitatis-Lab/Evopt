# Evopt

Evopt improves an existing TypeScript agent's **prompts and tool descriptions**, then returns a configuration patch and evidence for review.

You keep your agent, tools, models, and workflow. Evopt proposes bounded text edits, evaluates them on labeled tasks, and helps you decide which changes to adopt.

## The API

After explicitly configuring an [agent adapter and dataset](API.md#complete-offline-example), the optimization call is:

```ts
import { optimize } from "evopt";

const result = await optimize({
  agent,
  dataset,
  objective: "accuracy",
  budget: 10,
});
```

`agent` includes its runner, mutable fields, usage accounting, and proposer. `dataset` includes separate train, validation, and test cases. There are no hidden globals or default paid providers. See the [complete offline example](examples/offline.ts).

`budget: 10` means a **USD 10 total run ceiling** covering proposals and evaluations under the [accounting contract](API.md#usd-accounting-contract). It is not ten iterations or permission to spend money.

## Three core ideas

- **Understand the declared agent.** Node roles, tool contracts, and handoffs give proposals context. Only allowlisted prompts and descriptions can change; tool implementations and graph topology stay fixed.
- **Keep quality first.** Default selection improves validation accuracy. An optional policy selects equally accurate candidates with lower USD cost or token use, subject to an accuracy floor and per-case regression limits.
- **Learn from earlier attempts.** Later proposals receive bounded training comparisons and rejection feedback. Candidate lineage records what changed, its parent, and the proposal that produced it.

See [configuration, selection, and training experience](CONFIGURATION.md) to declare these settings. This is an optimization layer, not a new agent runtime.

## How improvement works

```text
Baseline → propose on training cases → select on validation → freeze
         → compare on held-out tests → review and reproduce → adopt
```

The target agent never receives expected answers or scoring functions. Validation and test observations stay outside proposal feedback. Your adapter creates fresh agent state for every evaluation.

A run returns before/after text, paired outcomes, regressions, uncertainty, and settled costs. You decide whether to apply its guarded patch and record a new baseline version. Use fresh held-out cases once previous test results have informed further tuning.

Evopt does not modify production agents or optimize its own implementation. Repeated evaluations and evidence of text reaching actual model requests are future work. Baseline adoption is explicit.

## Try it locally

From this checkout, with Node.js 22 or newer:

```sh
npm install
npm run demo
npm test
```

The demo and tests are offline and make no paid provider calls. The demo writes private evidence under `.evopt/runs/`. Benchmark tests need Git with a configured user identity; Python-dependent evaluator tests run when Python is available.

## Contribute an experiment

Contributors can improve agent text, add task suites or adapters, and submit reproducible results. Start with a free local experiment:

```sh
npm run experiment -- init --out .evopt/experiment.mjs
npm run experiment -- check --config .evopt/experiment.mjs --budget 10
npm run experiment -- run --config .evopt/experiment.mjs --budget 10 --out .evopt/runs/first
npm run experiment -- review --run .evopt/runs/first
```

The generated experiment is synthetic. Real paid runs require your explicit budget and `--allow-paid`; none are launched by these instructions alone. Keep unsuccessful results alongside improvements.

Follow [CONTRIBUTING.md](CONTRIBUTING.md) to prepare a real experiment, resume a run, export a reviewed patch, and submit evidence. [Experiments](experiments/README.md) contains shareable definitions.

## Integrations and benchmarks

Use your existing agent through a developer-supplied adapter. OpenAI, Anthropic, Gemini, explicitly configured compatible endpoints, and deterministic offline proposers are available. OpenAI and Anthropic configuration maps connect declared text to their request formats.

[Contributor assistant presets](INTEGRATIONS.md) include Codex, Claude Code, Cursor, Gemini CLI, and others. Those presets help operate Evopt; they do not supply an evaluated agent runtime.

**SWE-bench, Lite, and Verified are implemented** through a pinned local official harness. Your existing coding agent receives a fresh repository, produces a patch, and the Docker harness grades it. Follow [benchmark preparation](benchmarks/README.md) and the [SWE-bench experiment](experiments/swe-bench/README.md).

FrontierCode, Terminal-Bench, and SWE-Atlas-QnA-AA are assessed but **not implemented**. Inspect the [catalog and requirements](benchmarks/RESEARCH.md), or run `npm run benchmark -- list`. Offline fixtures demonstrate integration behavior, not real benchmark gains.

## Reference

- [API and complete setup](API.md): generic types, adapters, search, accounting, recovery, and the optional OpenAI proposer.
- [Configuration and review](CONFIGURATION.md): agent structure, selection policies, training experience, evidence, and guarded patches.
- [Contribution workflow](CONTRIBUTING.md): explicit budgets, reviewed exports, and reproduction.
- [Source](src/) · [Examples](examples/) · [Benchmarks](benchmarks/) · [Tests](test/).

## Scope and status

Evopt is an unpublished working implementation. A Python package already uses the name `evopt`; no package-name or trademark clearance is claimed.

GEPA, DSPy, Ax, and Opik provide relevant prior work. Evopt claims neither a new optimization algorithm nor the first framework-agnostic or TypeScript optimizer.

Scope is prompt and tool-description optimization. There is no arbitrary code generation, graph rewriting, model training, dashboard, SaaS account system, distributed execution, or online production self-modification.
