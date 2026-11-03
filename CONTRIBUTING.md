# Contribute an optimization result

Connect your existing coding agent, choose a USD ceiling, run a pinned SWE-bench experiment, and share the resulting configuration and evidence. Evopt's default objective is fewer tokens while preserving baseline task quality.

## Connect and prepare

Use Node.js 22 or newer from this checkout:

```sh
npm install
npm run swe -- init --out .evopt/swe-config.json --agent ./my-agent.mjs
```

`init` creates a draft configuration; it does not create a working coding agent or download benchmark assets. Your module exports a configured named `agent`. Follow [the connection example](experiments/swe-bench/README.md#connect-your-agent), then [prepare the benchmark](benchmarks/README.md#prepare-swe-bench).

Fill the draft with your manifest, private source export, agent module, Python executable, pinned official harness, and private evidence directory. Provision repository snapshots, Docker, dependencies, and required images separately. SWE-bench, Lite, and Verified use the same integration.

Before running:

- Pin agent/proposer/model versions, initial text, the mutable allowlist, dataset partitions, scorer/harness, and prices.
- Make every evaluation a fresh session and tool environment. Apply the supplied text to the actual prompts and tool descriptions.
- Account for every paid model call, retry, and paid tool operation inside an enforced invocation envelope.
- Keep gold patches, hidden tests, and grader reports outside the agent's accessible environment.

Agent modules are trusted code. Imports must not make provider calls or install software; paid work belongs inside the metered callbacks. See [the adapter and accounting contracts](API.md#adapt-an-existing-agent).

## Check and run

```sh
npm run swe -- check --config .evopt/swe-config.json --budget 10
npm run swe -- run --config .evopt/swe-config.json --budget 10 --out .evopt/runs/swe-1 --allow-paid
npm run swe -- review --run .evopt/runs/swe-1
```

The person paying chooses and authorizes the amount; `10` is only an example. The USD ceiling includes target evaluations, proposals, rejected proposals, and final held-out evaluation. Local harness compute and storage are excluded. Each new run directory has its own ceiling.

To also cap total tokens, add `--max-tokens 200000` to `check` and `run`, replacing the example count with your chosen limit. This includes both target and proposer input/output usage; cached input and reasoning are counted once as subsets. Inspect `minimumFits` and, when capped, `tokenMinimumFits` in the check output. `run` refuses insufficient baseline/holdout bounds before inference and protects the final comparison allowance.

Checks verify local setup and planned bounds without model inference. They do not prove a later Docker evaluation will succeed. Default selection requires strictly fewer validation tokens with at least baseline accuracy and zero observed baseline-case regressions; test results never select candidates.

For recovery, repeat the exact `run` command and directory with `--resume`. Unknown billing blocks resume. Keep the ledger and journal intact; inspect process ownership before removing stale `experiment.lock` or `run.lock` files. A different configuration or ceiling requires a new run. See [recovery details](API.md#durable-runs-and-recovery).

## Review and export

Review baseline/candidate token use, resolved tasks, individual regressions, uncertainty, accounted USD, and rejected proposals. A cheaper bill due to caching is not the same as fewer tokens. The token interval describes this task sample, not model rerun variance or guaranteed savings; see [evidence assumptions](CONFIGURATION.md#inspect-evidence-and-export-a-patch). Preserve null and inconclusive outcomes.

Before sharing, inspect candidate text, identifiers, receipt metadata, and summaries for private data and redistribution restrictions. Complete journals, source rows, outputs, and grader reports stay private under `.evopt/`; portable exports omit raw outputs and traces but still contain text and identifiers.

```sh
npm run swe -- submit --run .evopt/runs/swe-1 --out contributions/my-result --id my-result --summary "Describe the hypothesis and measured outcome" --reviewed
```

The command writes to a new output directory:

```text
contributions/my-result/
  submission.json   Portable configuration, lineage, outcomes, usage, and provenance
  patch.json        Guarded text changes for explicit application
  README.md         Result and reproduction information
```

It does not publish, open a PR, or alter shared defaults. It requires a completed run and settled billing. `--reviewed` records your review; it does not redact secrets or certify truth. Synthetic, identity-control, and non-improving results are labeled and cannot establish a real token-saving improvement.

You can validate the package again with:

```sh
npm run experiment -- validate --file contributions/my-result/submission.json
```

## Submit an improvement

Open a PR yourself with the reviewed package and shareable experiment material under `experiments/<experiment-id>/`. Include preparation commands, exact task counts and partitions, source/manifest hashes, evaluator revision, model/pricing pins, and known limitations. Never commit credentials or private run directories.

Report observed token savings and quality alongside cost. Custom SWE subsets are not official leaderboard results. Hashes and internally consistent receipts are integrity checks, not proof that a provider ran the calls or that a score is authentic.

Maintainers validate the package, inspect the text change and experiment code, and independently reproduce the result under a separately approved budget. Adoption is a human decision: record the accepted patch, parent baseline, evidence, and new version. Later tuning needs a fresh holdout after earlier test results have informed decisions.

## Other experiments and library contributions

`npm run demo` and `npm test` are offline. The demo uses explicit accuracy selection to illustrate integration; it does not establish measured token savings.

For non-SWE tasks, use `npm run experiment -- init --out .evopt/experiment.mjs` and the [general experiment workflow](experiments/README.md). A trusted experiment exports `id`, `description`, `agent`, `dataset`, and an optional objective. Omitted objectives default to `"tokens"`; explicit `"accuracy"` remains supported.

Choose contributor assistants and providers through [INTEGRATIONS.md](INTEGRATIONS.md). Keep library fixes separate from optimization evidence. Only declared prompts and tool descriptions are candidate edits; runtime code, permissions, topology, and model weights remain outside scope. Do not publish the working package or claim name clearance.

