# Evopt

Evopt searches for **prompt and tool-description changes that reduce your agent's token use while preserving measured task quality**. It returns a configuration patch and evidence you can review.

Your existing agent keeps its runtime, models, tools, and workflow. Evopt changes only the text you explicitly allow.

## Use your agent on SWE-bench

With Node.js 22 or newer, install this checkout and connect your existing agent in `my-agent.mjs`:

```sh
npm install
npm run swe -- init --out .evopt/swe-config.json --agent ./my-agent.mjs
```

The command creates a draft configuration. Follow the [agent connection example](experiments/swe-bench/README.md#connect-your-agent) and [benchmark preparation](benchmarks/README.md#prepare-swe-bench) to fill in your local dataset, repositories, Python, pinned harness, and Docker resources. No agent runtime or benchmark assets are installed automatically.

Check the setup, then run with a USD ceiling you have explicitly approved:

```sh
npm run swe -- check --config .evopt/swe-config.json --budget 10
npm run swe -- run --config .evopt/swe-config.json --budget 10 --out .evopt/runs/swe-1 --allow-paid
npm run swe -- review --run .evopt/runs/swe-1
```

`--budget 10` caps accounted inference spending at **USD 10**; it is not an iteration count. Add `--max-tokens 200000` to both `check` and `run` if you also want a total token ceiling. These example amounts are not spending authorization. The [accounting contract](API.md#usd-accounting-contract) covers target calls and proposals; local Docker compute and storage are separate.

After reviewing the result and its contents for sharing:

```sh
npm run swe -- submit --run .evopt/runs/swe-1 --out contributions/my-result --id my-result --summary "Describe the change and measured result" --reviewed
```

This writes a local package containing `submission.json`, `patch.json`, and a reproduction README. It does not publish or open a pull request. See [the contributor guide](CONTRIBUTING.md) for review, recovery, and adoption.

## The library API

After explicitly defining an [agent adapter and labeled dataset](API.md#complete-offline-example):

```ts
import { optimize } from "evopt";

const result = await optimize({
  agent,
  dataset,
  objective: "tokens", // The default; this property may be omitted.
  budget: 10,
});
```

The adapter supplies its runner, mutable fields, usage accounting, and proposer. The dataset supplies disjoint train, validation, and test cases. There are no hidden globals or default paid providers. Explicit `objective: "accuracy"` remains available.

## Three core ideas

- **Agent-aware edits.** Node roles, tool contracts, and handoffs give proposals context. Only allowlisted prompts and descriptions change.
- **Fewer tokens, preserved quality.** Default selection requires strictly fewer validation tokens, at least baseline accuracy, and zero regressions on cases the baseline passed. Higher accuracy alone is not a token-saving win.
- **Learning from attempts.** Proposals receive bounded training comparisons and rejection feedback. Lineage records each candidate's parent, changed fields, and proposal invocation.

```text
Baseline → propose on training → select on validation → freeze
         → compare on held-out tests → review and reproduce → adopt
```

The target never receives labels or scoring functions. Validation and test observations stay outside proposal feedback. Your adapter creates fresh state for every evaluation. Adoption is explicit; Evopt does not modify production agents or optimize its own implementation.

See [configuration and review](CONFIGURATION.md) for quality guards, training experience, and guarded patch application.

## Try the offline demo

```sh
npm run demo
npm test
```

These make no paid provider calls. The demo illustrates wiring with an explicit accuracy objective; it is not evidence of real token savings. Tests use authored fixtures. Benchmark tests need configured Git identity; Python-dependent tests run when Python is available.

## Support and reference

**SWE-bench, Lite, and Verified are implemented** using a pinned local official harness. FrontierCode, Terminal-Bench, and SWE-Atlas-QnA-AA are assessed but not implemented; inspect the [benchmark catalog](benchmarks/RESEARCH.md) or run `npm run benchmark -- list`.

OpenAI, Anthropic, Gemini, compatible endpoints, and offline proposers are available. [Integration options](INTEGRATIONS.md) distinguish model adapters from contributor assistants such as Codex, Claude Code, and Cursor. Assistant presets do not supply a target-agent runtime.

- [API reference](API.md): complete setup, generic types, accounting, evidence, and recovery.
- [SWE setup](experiments/swe-bench/README.md): connect your own agent and configure the local evaluator.
- [Contributing](CONTRIBUTING.md): create a reviewed evidence package and reproduce a result.
- [Source](src/) · [Examples](examples/) · [Benchmarks](benchmarks/) · [Tests](test/).

## Scope and status

Evopt is unpublished. A Python package already uses the name `evopt`; no name or trademark clearance is claimed. GEPA, DSPy, Ax, and Opik provide relevant prior work; Evopt claims no new optimization algorithm or first-of-its-kind status.

Scope is prompt and tool-description optimization. There is no arbitrary code generation, graph rewriting, model training, dashboard, SaaS account system, distributed execution, or production self-modification. Repeated evaluation and model-request attestation remain future work.
