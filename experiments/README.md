# Shareable experiments

This directory holds reviewed, reproducible experiment definitions. Private configurations, credentials, complete journals, and raw task evidence belong under `.evopt/`, not here. Portable reviewed result packages belong under `contributions/`.

Use one directory per experiment:

```text
experiments/<experiment-id>/
  README.md        # hypothesis, versions, preparation, commands, limitations
  experiment.mjs   # trusted general-agent adapter and experiment definition
  fixtures/        # optional redistributable inputs and local scoring fixtures
```

The experiment module exports `{ id, description, agent, dataset }` with an optional `objective`. Omitted objectives default to `"tokens"`, reducing tokens while preserving baseline quality; explicit `"accuracy"` remains available. Build the agent with the package's `defineAgent` API. Imports and initialization must be side-effect-free: paid operations belong only inside metered invocation callbacks. Do not place credentials in a shareable module.

An experiment README should explain:

- The starting configuration, the exact mutable prompt/tool-description fields, and their roles and length limits.
- The existing agent implementation and its version, isolated evaluation setup, proposer, model settings, and pinned USD accounting assumptions.
- Dataset origin, revision, redistribution permission, partition construction, scorer behavior, and reproducible setup commands.
- The hypothesis, evaluation task counts, known limitations, and the reviewed contribution file containing results, when available.
- Any previously accepted baseline's version and evidence reference, so a later improvement has a clear lineage.

Choose cases before a run. Use train feedback for proposals, validation for selection, and test only for the frozen final comparison. Maintainers need fresh held-out cases for follow-up comparisons after published results have informed the next experiment.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the free scaffold, explicit paid-run authorization, export, and review commands. A synthetic demo illustrates the workflow; it does not establish an optimization claim.

## Benchmark experiments

[SWE-bench](swe-bench/README.md) imports pinned instances, runs your existing coding agent in a fresh repository checkout, and grades its patch with the official Docker harness. Use `npm run swe -- init --out .evopt/swe-config.json --agent ./my-agent.mjs` to start its configuration workflow. It supports the SWE-bench, Lite, and Verified dataset families through a compatible pinned evaluator. The optimizer changes only declared prompts and tool descriptions, using the tokens objective.

SWE experiments use explicitly selected disjoint train/validation/test groups and carry benchmark provenance into contribution evidence. See [benchmark preparation](../benchmarks/README.md) before choosing a paid run budget and [the benchmark catalog research](../benchmarks/RESEARCH.md) for other software-engineering suites.

## Opt-in OpenAI text experiment

[`openai-text.mjs`](openai-text.mjs) supplies a working target-agent callback and the optional OpenAI proposer. It makes one text completion per target evaluation, with a fresh message list, no tools or retries, explicit token limits, and normalized usage. The only mutable field is its system prompt. It uses six public category-normalization fixtures; these test integration wiring, not general agent performance. Improvement is not guaranteed, and a paid result on these fixtures is still only smoke evidence.

Copy [`openai-settings.example.json`](openai-settings.example.json) into the ignored `.evopt/` directory. Replace every `null` with reviewed private values. Pin a model supporting structured JSON-schema output and `max_completion_tokens`, current applicable USD rates with their source and date, and invocation limits. `inputTokenOverhead` is your verified conservative bound for the pinned model's hidden message/schema framing. Set an explicit `maxAttempts`; do not treat the sample as recommended pricing or limits. A missing or incomplete settings file fails before inference. Omit `cacheReadUSDPerMillion` entirely if its applicable rate is unknown; the accounting fallback is conservative.

Point to that private file explicitly. In PowerShell:

```powershell
New-Item -ItemType Directory -Force .evopt | Out-Null
Copy-Item experiments/openai-settings.example.json .evopt/openai-settings.json
# Edit .evopt/openai-settings.json before continuing.
$env:EVOPT_EXPERIMENT_SETTINGS = (Resolve-Path .evopt/openai-settings.json).Path
npm run experiment -- check --config experiments/openai-text.mjs
```

In a POSIX shell, set the same variable with `export EVOPT_EXPERIMENT_SETTINGS="$PWD/.evopt/openai-settings.json"`. There is no default settings path and no fallback to another credential environment variable. Module loading reads the private settings but does not send requests. Do not commit that file.

After the person paying has chosen and authorized the ceiling, run with their amount and the paid-execution flag:

```sh
npm run experiment -- run --config experiments/openai-text.mjs --budget 10 --out .evopt/runs/openai-text-1 --allow-paid
npm run experiment -- status --run .evopt/runs/openai-text-1
```

`10` is only an example USD ceiling. Both target evaluations and proposals consume it. Use the [contribution export workflow](../CONTRIBUTING.md#review-and-export) after privacy review. For a useful optimization claim, replace the smoke fixtures with independently chosen representative tasks and a fresh holdout, and document the experiment rather than presenting these six fixtures as a benchmark.
