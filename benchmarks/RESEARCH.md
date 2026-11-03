# Software-engineering benchmark assessment

Reviewed 2026-11-03 against the primary sources below. This is an availability and integration assessment. No task corpus was downloaded, no model or judge was invoked, and no new benchmark adapter is implied by an entry in `catalog.ts`.

| Benchmark | Verified scope | Public availability | Evopt status |
| --- | --- | --- | --- |
| SWE-bench / Lite / Verified | Explicitly selected tasks from a pinned source export | Official datasets and Docker harness | Implemented local integration; no performance claim |
| FrontierCode 1.1 | Main: 100 tasks; Extended: 150 | Methodology and results public; task set withheld | Not implemented |
| Terminal-Bench 4.0.0 | 66 tasks | Public release and Harbor task packages | Not implemented |
| SWE-Atlas-QnA-AA | 124 tasks; 1,306 rubric criteria across the dataset | Public Parquet data and judge configuration | Not implemented |

Task counts describe the upstream suites, not Evopt train/validation/test sizes. An optimization subset must disclose its selected IDs and cannot inherit an official leaderboard label. The three assessed suites are distinct: repository implementation, terminal execution, and repository Q&A. [Artificial Analysis's primary methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking) records their counts and uses three attempts per task; Evopt's current single evaluation per case is a different protocol.

## FrontierCode 1.1

Cognition released 1.1 on 2026-07-07. Main contains 100 tasks and Extended contains 150; Diamond is deprecated. The “1000+” figure refers to grading criteria, not tasks. Version 1.1 changes blocker criteria and adds a fair-internet-use prompt plus a verifier that zeroes runs accessing solution material. [Release and methodology](https://cognition.com/blog/frontier-code-1.1).

The published design combines repository instructions with tests, command checks, reverse tests, scope checks, LLM review, and LLM-assisted adaptation of reference tests. Passing all blockers is separate from the weighted quality score. Cognition explicitly states that it does not plan to release the tasks publicly; the posts provide examples, not a downloadable complete task/schema/grader package. [Original benchmark description, grading table, and availability statement](https://cognition.com/blog/frontier-code).

**Integration assessment:** This fits prompt/tool-description optimization of an existing coding agent, but is not a reproducible public contributor suite without authorized task and grader access. An adapter would need exact rubric versions, environment snapshots, trajectory-based internet checks, and metering for model-based grading or service fees. Evopt currently accepts only boolean accuracy; substituting blocker pass/fail for the weighted headline score would require an explicitly different reported metric. No availability, pricing, or deterministic-grader assumptions should fill these gaps.

## Terminal-Bench 4.0.0

The official release is public at tag `v4.0.0`, commit `452bf305c6daa62fc59061d22133a7cbc7c1572e`, and published as `terminal-bench/terminal-bench@4.0.0` on Harbor Hub. It updates task resources and verifiers and removes eight tasks. Its release post sets agent timeouts to eight hours. [Release](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.0.0), [release methodology](https://www.tbench.ai/news/terminal-bench-4-0). The full suite includes GPU tasks; a CPU-only subset must be labeled accordingly. [Official run instructions](https://www.tbench.ai/run).

This is an environment task format, not SWE-bench's issue/patch JSON: a Harbor task contains `instruction.md`, `task.toml`, environment definitions, private verifier files, and reference-solution files. The verifier emits a numerical reward, so an adapter must validate the selected benchmark's pass/fail convention rather than interpreting every nonzero generic Harbor reward as success. [Harbor task schema](https://docs.harborframework.com/tasks/overview).

Passing automated tests is not the entire published integrity protocol. Terminal-Bench requires trajectories for passing trials and uses an agent judge to identify reward hacking. [Official integrity policy](https://www.tbench.ai/news/leaderboard-integrity-update). Artificial Analysis's current 4.0 protocol runs Claude Code with Claude Sonnet 5 over passing trajectories and zeroes flagged attempts. That is a model invocation with cost and nondeterminism, separate from the task's test script. [AA integrity methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking#terminal-bench-40).

**Integration assessment:** This is the strongest next public execution-benchmark candidate. Reuse an explicitly configured existing terminal agent; do not add a new runtime to Evopt. An adapter still needs pinned task/image/verifier revisions, resource parity, fresh environments, protected tests/solutions, artifact-to-result binding, failure classification, and complete target usage. Preserve trajectories and meter integrity review before claiming protocol equivalence. Provision GPU/cloud resources separately and disclose infrastructure charges outside the inference contract. Changed resource limits or missing integrity checks produce a custom evaluation, not a comparable official score.

## SWE-Atlas-QnA-AA

The public dataset has one `test` split with 124 tasks. It preserves the upstream questions, repository commits, images, and reference answers while adjusting 127 of 1,306 rubric criteria. Each task passes only when all of its own criteria pass; the 1,306 figure is the suite-wide total. The HF viewer exposes `task_id`, `prompt`, `reference_answer`, `repository_url`, `repository_base_commit`, `language`, `category`, `rubric`, and `docker_image`; `rubric` is serialized JSON text. [Dataset card and schema](https://huggingface.co/datasets/ArtificialAnalysis/SWE-Atlas-QnA-AA).

The inspected HF revision is `1f28d51b6e191e9f2bfdc22b09d92eecdab6654e`. Its judge configuration specifies GPT-6 Luna at `xhigh`, five votes per criterion, majority decisions, structured reason/evidence/verdict output, a 16,384-token completion limit, and `max_retries: 8`. Negative polarity is applied after voting. Malformed or truncated output is not a vote; incomplete five-vote criteria are unscored, not failures. The answer date is part of the grading input. [Pinned judge configuration](https://huggingface.co/datasets/ArtificialAnalysis/SWE-Atlas-QnA-AA/blob/1f28d51b6e191e9f2bfdc22b09d92eecdab6654e/rubric_evaluation_config.yaml).

Scale publishes runnable task packages and instructions, but its upstream grader configuration is not the AA configuration. Do not silently substitute upstream rubric text, judge, or agent settings. [Scale's repository](https://github.com/scaleapi/SWE-Atlas). AA also fails attempts that change tracked repository files. [AA scoring policy](https://artificialanalysis.ai/methodology/coding-agents-benchmarking#scoring-and-outcomes).

**Integration assessment:** Repository Q&A complements patch tasks and preserves Evopt's prompt-only candidate boundary. Feed the target the question and isolated pinned repository, keeping rubric/reference answers private. The blocking work is a metered judge contract: reserve costs before dispatch, include judge retries in the same run ceiling, persist individual votes for resume, and treat incomplete grading as an infrastructure interruption. A complete one-answer-per-task pass requires 6,530 valid criterion votes before retries (1,306 × 5), not 124 cheap local checks. Freeze answer dates, judge prompts, rubric revision, and model settings. Voting improves stability but does not make model grading deterministic.

## Decision for this repository

Keep SWE-bench as the implemented path. List the three researched suites with `not-implemented` status and their concrete prerequisites. Pursue a bounded Terminal-Bench adapter next if execution-benchmark expansion is authorized; add metered grading before implementing AA-faithful Q&A or integrity judges. FrontierCode remains access-dependent. None of this authorizes dataset provisioning, cloud resources, paid evaluation, or changes to Evopt's prompt/tool-description-only optimization scope.
