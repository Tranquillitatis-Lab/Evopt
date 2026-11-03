# Reduce your agent's tokens on SWE-bench

Evopt changes declared prompts and tool descriptions. Your existing coding agent repairs issues in fresh repositories, and the pinned official SWE-bench Docker harness grades its patches. Default selection looks for fewer tokens with at least baseline accuracy and zero observed regressions on baseline-passing cases.

This integration supports SWE-bench, Lite, and Verified. Begin with [benchmark preparation](../../benchmarks/README.md#prepare-swe-bench): reviewed local source rows, disjoint partitions, prepared repositories, Python, a pinned harness checkout, Docker, and required images. Keep gold patches and hidden tests in private evaluator data.

## Connect your agent

Create `my-agent.mjs` exporting a named `agent`. The following is an **application integration shape**, not a supplied coding runtime: implement or import `createSession`, `accounting`, and `proposer` from your own reviewed application. Their names and methods should match your actual API.

```js
import { fileURLToPath } from "node:url";
import { createSWEAgent, collectSWEPatch } from "evopt/benchmarks";
import { createSession, accounting, proposer } from "./existing-agent.mjs";

export const agent = createSWEAgent({
  id: "my-coding-agent",
  version: "1",
  workspaceRoot: fileURLToPath(new URL("./.evopt/workspaces/", import.meta.url)),
  components: {
    systemPrompt: "Repair the reported issue and verify the change.",
    readToolDescription: "Read a source file inside the task repository.",
  },
  mutable: {
    systemPrompt: { role: "Repair instructions", maxLength: 4000 },
    readToolDescription: { role: "Explain the source-reading tool", maxLength: 800 },
  },
  accounting, // Enforced whole-invocation limits and pinned USD prices.
  optimization: { proposer, maxAttempts: 3 },
  async run({ input, components, context, workspace }) {
    const session = await createSession({
      workspace,
      systemPrompt: components.systemPrompt,
      readToolDescription: components.readToolDescription,
      evaluationId: context.evaluationId,
      limits: context.limits,
    });
    try {
      const result = await session.run(input.problemStatement, {
        signal: context.signal,
      });
      return {
        output: await collectSWEPatch(workspace, input.baseCommit),
        usage: result.usage, // Complete normalized receipts for every paid call.
      };
    } finally {
      await session.close();
    }
  },
});
```

Adapt the callback to your agent's real configuration, execution, cleanup, and usage APIs; the example's `close()` is local cleanup and must not make unmetered model calls. No CLI command is inferred or run for you. `createSWEAgent` supplies a fresh checkout at the pinned base commit; `collectSWEPatch` collects tracked, new nonignored, and committed changes against that base.

Your callback must create fresh conversation/tool state, enforce the [accounting envelope](../../API.md#usd-accounting-contract), and respect cancellation. Restrict access to the task environment so it cannot read the private dataset or grader evidence. Sanitized inputs omit gold patches, hidden-test patches, hints, and outcome labels. Imports must make no inference calls.

## Configure local resources

```sh
npm run swe -- init --out .evopt/swe-config.json --agent ./my-agent.mjs
```

The draft contains:

```json
{
  "version": 1,
  "manifest": "<prepared-manifest.json>",
  "datasetFile": "<private-source.json>",
  "agentModule": "<path-to-your-agent-module>",
  "harness": {
    "python": "<absolute-python-executable>",
    "cwd": "<pinned-SWE-bench-checkout>",
    "revision": "<full-40-character-harness-commit>",
    "evidenceDirectory": "./swe-evidence",
    "timeoutMs": 3600000,
    "instanceTimeoutSeconds": 1800
  }
}
```

Replace placeholders with reviewed local resources. `init` records your supplied agent path. Optional `--manifest`, `--source`, `--python`, `--harness`, `--revision`, and `--evidence` arguments can fill those settings directly.

Paths in JSON resolve relative to that file, except Python, which must be an absolute executable path. Pin the dataset source revision and bytes, repository base commits, and evaluator revision separately. `version` may be omitted in older configurations; when supplied it must be `1`.

## Check, run, and review

```sh
npm run swe -- check --config .evopt/swe-config.json --budget 10
npm run swe -- run --config .evopt/swe-config.json --budget 10 --out .evopt/runs/swe-1 --allow-paid
npm run swe -- review --run .evopt/runs/swe-1
```

The loader verifies the manifest/source, repositories, evaluator, Docker connectivity, and selected local images before importing the named agent. It makes no model requests; your module's imports must also be free of inference. Inspect `minimumFits` and, when capped, `tokenMinimumFits` before running. A successful check is not a completed benchmark evaluation. Missing assets must be provisioned separately.

Choose and authorize the USD amount before running; `10` is illustrative. For a separate total token limit, add `--max-tokens 200000` to both `check` and `run`. Both ceilings cover target and proposer calls, including rejected proposals and final evaluation. Docker compute/storage are outside the USD inference contract. Resume a matching interrupted run with the same settings and `--resume`; unresolved billing stops automatic recovery.

The workflow uses `objective: "tokens"`. Proposals learn from training evidence; validation selects strictly fewer-token candidates subject to baseline-quality guards. Equal-token or more-token candidates do not win merely by increasing accuracy. Final tests compare the frozen choice with the baseline.

## Prepare a contribution

```sh
npm run swe -- submit --run .evopt/runs/swe-1 --out contributions/my-result --id my-result --summary "Describe the change and measured token savings" --reviewed
```

Review privacy and redistribution permissions first and choose a new output directory. The local package contains `submission.json`, `patch.json`, and `README.md`; no PR is opened and nothing is published. Follow [contribution review](../../CONTRIBUTING.md#review-and-export).

Report exact subset counts, token totals, resolved tasks, regressions, USD costs, and source/evaluator pins. Preserve private official reports for reproduction. These custom optimization partitions are not official leaderboard splits; fixture tests are not public benchmark results. Use fresh holdouts for later tuning.

## Existing experiment-module workflow

The earlier module entry point remains available. Set `EVOPT_SWE_CONFIG` to the absolute path of this same reviewed JSON file, then use `npm run experiment -- check --config experiments/swe-bench/experiment.mjs --budget 10`.

The wrapper delegates to the exported `loadSWEExperiment(configPath)`; the `npm run swe` commands take the config path directly and need no environment variable.
