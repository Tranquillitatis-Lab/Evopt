# Contributing optimization experiments

Contributors can spend their own explicitly approved token budget to propose better prompts and tool descriptions, then submit the resulting configuration and evidence for review. An accepted improvement becomes a versioned starting point for a later experiment. Evopt never installs a candidate or changes production agents automatically.

The workflow follows OPS-GA's useful separation between experiments, private run evidence, and reviewed contributions. It uses Evopt's general-agent adapter and USD accounting contract; no particular agent framework is required.

Choose your contributor assistant and target provider using [INTEGRATIONS.md](INTEGRATIONS.md). These are separate choices: a Cursor or Claude Code brief guides the contributor workflow; a metered model API adapter runs inside the optimization budget. The integration listing distinguishes built-ins from SDKs that still need custom adapters.

## Start with a free run

Use Node.js 22 or newer. From the repository root:

```sh
npm install
npm test
npm run experiment -- init --out .evopt/experiment.mjs
npm run experiment -- check --config .evopt/experiment.mjs
npm run experiment -- run --config .evopt/experiment.mjs --budget 1 --out .evopt/runs/first-run
npm run experiment -- status --run .evopt/runs/first-run
```

The generated experiment uses a deterministic local agent and proposer. It spends zero and demonstrates the complete workflow. Its scores are synthetic evidence, not a benchmark result or a reason to change a shared default. `--budget 1` is a USD ceiling, not a number of iterations.

`run` includes train/validation search and final held-out evaluation. `validate` below checks a submission file; it does not open a test partition or make provider calls. Use a fresh output directory for a new experiment. To resume, repeat the same `run` command, directory, budget, and paid authorization with `--resume`. Unknown billing blocks resume. After a process crash, both `experiment.lock` and `run.lock` may remain; verify their owners have stopped before removing stale locks, and never delete the ledger or journal. The library's explicit resume API is documented in the [README](README.md#durable-runs-and-recovery).

## Bring an existing agent

An experiment module exports an object containing `id`, `description`, `agent`, `dataset`, and `objective: "accuracy"`. Configure `agent` with `defineAgent` as shown in the [adapter guide](README.md#adapt-an-existing-agent). Its mutable allowlist should contain only the specific prompt or tool-description fields being investigated.

For a reproducible experiment:

- Pin the agent implementation, starting components, proposer, model settings, dataset revision, and scorer version. Explain the intended improvement before examining test results.
- Declare disjoint train, validation, and test cases. Keep the scorer local and deterministic, and never pass labels to the target agent.
- Create fresh agent state and isolated tool fixtures inside every invocation. Wire the supplied components into the agent's actual prompts and tool descriptions.
- Account for every paid model call, retry, and paid tool operation. Review the constant invocation envelope, enforced limits, and pricing provenance against the [accounting contract](README.md#usd-accounting-contract).

Experiment modules and adapter callbacks are trusted application code. Loading a module executes its top-level code. Keep imports and module initialization free of provider calls, installations, and other side effects; put paid operations inside the metered runner or proposer callbacks. Read an unfamiliar experiment before running `check` or `run`.

The existing OpenAI proposer is optional. Provide its credentials and reviewed model/pricing configuration explicitly in your private module. Do not put keys in an experiment committed to this repository. There is no implicit provider configuration or free subscription balance.

## Spend an explicit budget

First run the configuration check and review its output. A paid experiment requires both a numeric USD ceiling and `--allow-paid`:

```sh
npm run experiment -- check --config .evopt/experiment.mjs
npm run experiment -- run --config .evopt/experiment.mjs --budget 10 --out .evopt/runs/reviewed-run --allow-paid
npm run experiment -- status --run .evopt/runs/reviewed-run
```

The amount `10` is an example, not spending authorization. The person paying must choose the amount and authorize paid execution. If directing a coding assistant, a useful request is: “Read CONTRIBUTING.md, inspect my experiment, and run it with a total ceiling of USD X. Stop at the ceiling and keep the evidence private for my review.” Supply the actual amount; never infer it from this guide.

The ceiling covers target-agent evaluations and candidate proposals, including rejected proposals. Final-test funds are protected before search. A separate invocation with a new run directory has a separate ceiling; do not treat several runs as one shared budget. Unknown billing stops execution and blocks automatic retry. Do not remove reservations or increase a recorded ceiling to make evidence appear compliant.

## Review and export

Keep private modules and full runs under `.evopt/`, which is ignored by Git. Before exporting, inspect the candidate text, identifiers, summaries, receipt metadata, and evidence you intend to share. Confirm that you have permission to redistribute those fields. Raw inputs, expected answers, outputs, and traces are not included in the portable submission, but prompts and identifiers can still contain private information.

After that review:

```sh
npm run experiment -- export --run .evopt/runs/reviewed-run --out contributions/my-improvement.json --id my-improvement --summary "Describe the bounded change and observed result" --reviewed
npm run experiment -- validate --file contributions/my-improvement.json
```

Inspect the resulting JSON again before committing it. `--reviewed` records a contributor's review; it does not redact secrets or certify that an experiment is truthful. A completed run with settled billing is required. Synthetic and unchanged-candidate evidence remains visibly labeled and cannot establish a real improvement.

The submission contains candidate text, changes, evaluation outcomes, normalized usage, accounting, provenance, and integrity hashes. Hashes detect accidental changes; they do not prove that a provider ran the calls or that the scorer is valid. Keep original private evidence available for an agreed review process rather than committing the run directory.

## Submit an improvement

Open a pull request with the reviewed JSON and enough reproducible experiment material for a maintainer to assess it. Put shareable experiment definitions and explanations under `experiments/<experiment-id>/`. Include pinned dependency/model/dataset information and preparation instructions; use placeholders or explicit injected configuration for credentials. If a dataset or agent is private, explain what maintainers can reproduce and narrow the claim accordingly.

Report the baseline and candidate results, task count, actual accounted cost, rejected proposals, and any regressions. Distinguish a smoke demonstration, an identity control, and independent baseline/candidate observations. Do not call a tiny fixture suite a public benchmark, infer statistical significance from one run, or remove difficult cases after seeing results.

Maintainers validate the package, review the text changes and experiment code, and independently rerun an accepted experiment with an explicitly approved budget. A new comparison needs a fresh holdout that has not influenced human or automated selection. Shared test results cannot remain hidden after contributors use them to choose the next variant.

Promotion is a separate human decision. If accepted, commit the reviewed configuration as the next versioned baseline and preserve its parent version and evidence reference. Start subsequent search from that baseline on new evaluation data. This is the contribution cycle by which configurations evolve; no submission automatically merges itself, edits runtime code, or deploys a new default.

## Repository boundaries

Keep ordinary library fixes separate from optimization evidence. Model-proposed changes are limited to declared text components; tool implementations, permissions, graph topology, model weights, and arbitrary source code are outside the optimization scope. Do not publish this working package or claim name clearance.

Use your own Git identity. Do not add AI attribution trailers or generated-by footers to commits, pull requests, issues, or comments. Human co-authors and sign-offs remain unchanged.
