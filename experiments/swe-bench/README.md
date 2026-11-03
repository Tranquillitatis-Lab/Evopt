# SWE-bench prompt and tool-description experiment

This experiment evaluates your existing coding agent on SWE-bench. Evopt proposes bounded changes to its declared prompts and tool descriptions. The agent works in a fresh base-commit checkout and returns a patch; the pinned official SWE-bench harness evaluates that patch in Docker. SWE-bench, SWE-bench Lite, and SWE-bench Verified share this integration.

First follow [benchmark preparation and checks](../../benchmarks/README.md#prepare-swe-bench). Keep the complete dataset export private: it contains gold patches and hidden-test information needed by the evaluator, not the agent. Provision local repository snapshots, a reviewed official harness checkout, its Python dependencies, and Docker before starting a paid run.

Create a private configuration under `.evopt/`:

```json
{
  "manifest": "swe-manifest.json",
  "datasetFile": "swe-source.json",
  "agentModule": "swe-agent.mjs",
  "harness": {
    "python": "<absolute-path-to-python-executable>",
    "cwd": "<path-to-official-SWE-bench-checkout>",
    "revision": "<full-40-character-harness-commit>",
    "timeoutMs": 3600000,
    "instanceTimeoutSeconds": 1800,
    "evidenceDirectory": "swe-grading"
  }
}
```

Replace all placeholders with reviewed values. `manifest`, `datasetFile`, `agentModule`, `harness.cwd`, and `harness.evidenceDirectory` resolve relative to this configuration file. Python must be an absolute executable path. The source revision, source-file hash, task base commits, and evaluator revision serve different purposes; preserve all of them with the experiment.

Your trusted `agentModule` must export a named `agent`. Use `createSWEAgent` from `evopt/benchmarks` with your normal `defineAgent` settings and an explicit `workspaceRoot`. Its `run({ input, components, context, workspace })` callback connects your existing coding agent to the fresh task checkout. It must return the generated patch string as `output` plus complete normalized `usage`. `collectSWEPatch(workspace, input.baseCommit)` collects tracked, new, and committed changes against the pinned base using fixed Git commands; using it does not supply an agent runtime.

The callback must create a fresh session, apply the supplied components, enforce its complete invocation envelope, and respect `context.signal`. Limit filesystem/tool access to the task environment so private dataset exports and grader reports cannot be read. The sanitized input excludes gold patches, hidden test patches, hints, and test-result labels. A developer-controlled adapter is still responsible for isolation beyond the callback boundary.

Declare only the prompt and tool-description components under investigation as mutable. Attach a proposer explicitly, pin its model/pricing settings, and account for all target/proposer model calls, retries, and paid tool operations. OpenAI, Claude, Cursor, or another system can participate through your existing metered adapter; this experiment does not infer their accounting or launch an unconfigured coding CLI. Importing `agentModule` must never start paid work.

Set the config path explicitly in PowerShell and check the experiment:

```powershell
$env:EVOPT_SWE_CONFIG = (Resolve-Path .evopt/swe-config.json).Path
npm run experiment -- check --config experiments/swe-bench/experiment.mjs --budget 10
```

In a POSIX shell, use `export EVOPT_SWE_CONFIG="$PWD/.evopt/swe-config.json"`. Loading the module verifies the dataset, repositories, evaluator configuration, Docker connectivity, and selected local instance images before importing your agent module. Missing images must be provisioned separately. These checks perform no model inference and do not claim to have completed a Docker benchmark run.

After the person paying chooses and authorizes the USD ceiling:

```sh
npm run experiment -- run --config experiments/swe-bench/experiment.mjs --budget 10 --out .evopt/runs/swe-1 --allow-paid
npm run experiment -- status --run .evopt/runs/swe-1
```

`10` is an example ceiling, not authorization. The ceiling includes target inference and candidate proposals, including rejected proposals and final held-out evaluation. Local Docker compute, storage, and preparation remain outside the inference-accounting contract. The official harness may need images and dependencies to be built or pulled; configure that environment separately.

The selected upstream source split is divided into explicit custom train/validation/test partitions. Training feedback contains task inputs, generated patches, and pass/fail results; expected values are instance IDs, never gold patches. Validation selects the text configuration. Final test evaluates the frozen selection, and its results must not guide further tuning on the same holdout.

Follow the normal [contribution export workflow](../../CONTRIBUTING.md#review-and-export). Report exact instance selection and counts, baseline/candidate resolution scores, regressions, accounted inference cost, source/manifest hashes, and evaluator/environment pins. Preserve official reports and patch evidence privately for review. Do not describe a selected subset, an authored fixture, or a mock evaluator run as an official leaderboard score.
