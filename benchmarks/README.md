# Benchmark adapters

SWE-bench is the main benchmark workflow, following back-ops-ga's separation of task import, agent execution, and official grading. Evopt imports reviewed tasks, gives an existing coding agent a fresh repository at the task's base commit, and evaluates its patch with the pinned official Docker harness. The optimizer changes only allowlisted prompts and tool descriptions. Your existing agent retains its runtime, tools, permissions, and accounting.

```text
benchmarks/
  import-swe.ts     Pinned SWE-bench source import and sanitized task manifest
  swe-workspace.ts  Fresh base-commit workspaces and patch collection
  swe-bench.ts      Pinned official SWE-bench harness and evaluation evidence
  swe-adapter.ts    Dataset adapter connecting patches to resolved/unresolved scores
  harness.ts       Shared trusted local process and checkout verification
  catalog.ts       Implemented benchmarks and explicitly unimplemented assessments
  RESEARCH.md      Source-backed availability, scoring, and integration assessment
```

| Benchmark | Support | Measurement |
| --- | --- | --- |
| SWE-bench, SWE-bench Lite, SWE-bench Verified | Local source import, existing coding-agent adapter, official Docker harness | Whether each selected issue is resolved |
| FrontierCode 1.1 | Assessed; not implemented; task access required | Mergeability blockers and weighted quality rubrics |
| Terminal-Bench 4.0 | Assessed; not implemented; Harbor integration required | Terminal-task execution with verifier and integrity checks |
| SWE-Atlas-QnA-AA | Assessed; not implemented; metered judge support required | Repository answers passing every criterion for the task |

`npm run benchmark -- list` reads the single catalog and distinguishes implemented support from researched candidates. See [RESEARCH.md](RESEARCH.md) for official sources, task counts, access limits, and paid-grader requirements. No benchmark selects a paid provider or grants spending authorization. Package tests use authored data and local mock evaluators; they do not run or establish a real benchmark score.

## Prepare SWE-bench

Provision these inputs separately before running optimization:

- A reviewed local JSON export of the complete official source rows, with its SHA-256, dataset identity, full source revision, and source split. Keep gold patches and hidden-test fields private.
- Local repository snapshots under an absolute repository root, named by replacing `/` in each source `repo` with `__` (for example, `owner/repository` becomes `owner__repository`). Each repository must contain the selected task's full `base_commit`.
- A clean, commit-pinned [official SWE-bench checkout](https://github.com/SWE-bench/SWE-bench), an absolute Python executable with its dependencies installed, and the Docker environment required by the [official evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/). Record interpreter, dependencies, platform, and container images with the experiment.

The supported source identities include `SWE-bench/SWE-bench`, `SWE-bench/SWE-bench_Lite`, and `SWE-bench/SWE-bench_Verified`. These identify the imported source; evaluation uses the local file instead of downloading a dataset by name. Select actual instance IDs from the pinned export before tuning. Your split file must contain three nonempty, disjoint string arrays named `train`, `validation`, and `test`.

```sh
npm run benchmark -- prepare --benchmark swe-bench --source <private-source.json> --sha256 <file-sha256> --revision <40-character-source-revision> --dataset SWE-bench/SWE-bench_Lite --source-split test --repositories <absolute-repository-root> --splits <private-splits.json> --out .evopt/swe-manifest.json
```

In PowerShell, `(Get-FileHash -Algorithm SHA256 <path>).Hash.ToLowerInvariant()` gives the source file hash. Use the pinned dataset revision for `--revision`, not a repository task's base commit or the evaluator revision. Import verifies the file hash and selected IDs. It produces sanitized task inputs; `patch`, `test_patch`, `hints_text`, `FAIL_TO_PASS`, and `PASS_TO_PASS` are not forwarded to the target. The scorer's expected value is the instance ID, not the gold patch.

An upstream split such as `test` and Evopt's three optimization partitions are different concepts. Dividing an upstream split into train/validation/test creates a **custom optimization subset**, not an official leaderboard split. Report the source, exact selection, and partition sizes. Source pinning identifies bytes; contributors must still establish their source's authenticity.

## Check and evaluate SWE-bench

```sh
npm run benchmark -- check --manifest .evopt/swe-manifest.json --source <private-source.json> --python <absolute-python-executable> --harness <official-SWE-bench-checkout-root> --revision <40-character-harness-revision> --evidence .evopt/swe-grading
```

The check verifies the source, manifest, local repositories, configured evaluator, Docker connectivity, and availability of the selected instance images. It does not pull or build missing images, invoke an agent or proposer, or complete a Docker evaluation. Keep private source files and grading evidence outside the coding agent's workspace, and constrain the existing agent's tools so they cannot read those locations. Passing sanitized callback arguments does not sandbox an unrestricted agent process.

To evaluate an already prepared patch for one selected instance:

```sh
npm run benchmark -- evaluate --manifest .evopt/swe-manifest.json --source <private-source.json> --python <absolute-python-executable> --harness <official-SWE-bench-checkout-root> --revision <40-character-harness-revision> --evidence .evopt/swe-grading --instance <selected-instance-id> --patch <patch.diff> --run-id <new-unique-run-id>
```

The adapter writes an official predictions file, invokes `swebench.harness.run_evaluation`, and retains official reports and diagnostics. Every attempt needs a fresh run ID because the [official harness caches evaluations by run and instance](https://www.swebench.com/SWE-bench/guides/evaluation/#result-caching). Use a compatible pinned harness that writes `logs/evaluation/<run-id>/results.json`. A proven patch-application failure counts as a failed answer; missing results, infrastructure failures, and ambiguous failures stop evaluation. `--timeout-ms` bounds the evaluator process; `--instance-timeout-seconds` configures its per-instance test timeout. If the process is interrupted, inspect the run's Docker resources: terminating Python does not guarantee container cleanup.

Evaluation runs repository tests in Docker. Provision its dependencies and images explicitly; the upstream harness may build or pull images according to its configuration. Local Docker compute, storage, and provisioning are outside Evopt's inference USD ceiling. These commands do not call a paid model.

## Optimize an existing coding agent

The [SWE-bench experiment](../experiments/swe-bench/README.md) connects a prepared manifest to a named agent export from your trusted application module. `createSWEDataset` provides `Dataset<SWEInput, string>`; the agent's output is a patch string. `createSWEAgent` wraps explicit agent settings and prepares a fresh checkout for each invocation. Its callback receives `input`, `components`, `context`, and `workspace`; your existing agent performs the task there. `collectSWEPatch(workspace, input.baseCommit)` is an optional fixed Git-diff helper.

No particular coding assistant or framework is required. An integration must supply a fresh session, enforced execution limits, complete normalized usage receipts, and cancellation handling. Every model call, retry, and paid tool call is part of the declared envelope. Model API text runners alone do not supply a repository-editing agent.

Candidates are prompt/tool-description patches. Repository patches are outputs produced by the evaluated coding agent, not changes the optimizer may make to its own runtime. Validation chooses the text configuration; the final test compares the frozen selection with the baseline. Reports, patches, and private source rows remain under the contributor's control.

## Report and reproduce

Use the [contributor export workflow](../CONTRIBUTING.md#review-and-export). Include dataset identity and revision, source/manifest hashes, exact partition sizes, evaluator revision, environment setup, baseline/candidate scores, regressions, and accounted inference cost. Keep raw prompts, patches, verifier labels, and evaluator reports private until separately reviewed for sharing. Run and submission provenance preserve benchmark pins; hashes do not prove that a claimed score is authentic.

A later optimization or human-guided revision needs a fresh held-out suite once previous test results have influenced decisions. A single evaluation per task does not establish statistical significance. Authored test fixtures exercise mechanics only and must never be presented as evidence of agent improvement.
