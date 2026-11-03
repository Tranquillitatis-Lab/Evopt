export type AssistantId = 'codex' | 'claude-code' | 'cursor' | 'gemini-cli' | 'github-copilot' | 'opencode' | 'aider' | 'cline' | 'roo-code';

/** Contributor onboarding only; this does not declare an automated target adapter. */
export interface AssistantPreset {
  readonly id: AssistantId;
  readonly name: string;
  readonly kind: 'contributor-assistant';
  readonly automaticTarget: false;
}

const assistants: readonly AssistantPreset[] = Object.freeze([
  ['codex', 'OpenAI Codex'],
  ['claude-code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['gemini-cli', 'Gemini CLI'],
  ['github-copilot', 'GitHub Copilot'],
  ['opencode', 'OpenCode'],
  ['aider', 'Aider'],
  ['cline', 'Cline'],
  ['roo-code', 'Roo Code'],
].map(([id, name]) => Object.freeze({ id: id as AssistantId, name: name!, kind: 'contributor-assistant' as const, automaticTarget: false as const })));

const aliases = new Map<string, AssistantId>([
  ['openai', 'codex'], ['claude', 'claude-code'], ['copilot', 'github-copilot'], ['gemini', 'gemini-cli'],
]);

export function listAssistants(): readonly AssistantPreset[] { return assistants; }

export function resolveAssistant(name: string): AssistantPreset {
  if (typeof name !== 'string') throw new Error('Assistant must be a supported name');
  const normalized = name.trim().toLowerCase();
  const id = aliases.get(normalized) ?? normalized;
  const preset = assistants.find(assistant => assistant.id === id);
  if (!preset) throw new Error(`Unsupported contributor assistant: ${name}. Choose ${assistants.map(assistant => assistant.id).join(', ')}`);
  return preset;
}

/** A portable prompt to paste into the selected assistant, without launching it. */
export function renderAssistantBrief(name: string): string {
  const assistant = resolveAssistant(name);
  return `# Evopt contributor brief for ${assistant.name}

Use ${assistant.name} as the contributor assistant operating this repository. This preset is a portable onboarding prompt, not an automatic optimization-target adapter, SDK integration, or native application configuration.

Read README.md and CONTRIBUTING.md first. Evopt optimizes only developer-declared prompts and tool descriptions in existing agents. Do not rewrite runtime code, permissions, tool implementations, model settings, or agent topology as candidate changes.

Inspect the selected experiment's trusted code, mutable allowlist, dataset partitions, local scorer, pinned model/pricing, and enforced invocation envelopes. Module imports must perform no inference. Build and test with offline or mocked providers; do not make paid calls while implementing or verifying code.

Use the repository commands from its root:

1. npm run experiment -- init --out .evopt/experiment.mjs
2. npm run experiment -- check --config .evopt/experiment.mjs
3. npm run experiment -- run --config .evopt/experiment.mjs --budget <USD_AMOUNT> --out .evopt/runs/<RUN_ID>
4. npm run experiment -- status --run .evopt/runs/<RUN_ID>
5. npm run experiment -- export --run .evopt/runs/<RUN_ID> --out contributions/<SUBMISSION_ID>.json --id <SUBMISSION_ID> --summary <REVIEWED_SUMMARY> --reviewed
6. npm run experiment -- validate --file contributions/<SUBMISSION_ID>.json

Replace placeholders with reviewed values. The scaffold is free and synthetic; it is not benchmark evidence. For a paid run, use the actual configured experiment and add --allow-paid only when the person paying has explicitly authorized that run and its USD ceiling. Honor an authorization already given for the same scope; do not request it again. If the ceiling or authorization is missing, ask before dispatch. There is no default spending amount. Never infer authorization from examples, API-key presence, or a subscription balance, and never translate subscription credits into USD without an explicit accounting contract.

The USD ceiling covers Evopt-dispatched target evaluations and candidate proposals, including paid operations inside those invocations. Your own ${assistant.name} conversation and tool usage outside Evopt is outside the Evopt ledger; disclose that separate usage and do not claim a combined ceiling.

Use fresh agent state and isolated tool fixtures for every evaluation. Feed only training evidence into proposals; validation chooses candidates, and the test split evaluates the frozen winner. Do not tune on test results. Preserve reservations and stop on unknown billing or envelope violations. Resume only with the original configuration, directory, and budget; never clear billing or increase a recorded ceiling to continue.

Keep credentials, private datasets, and full evidence in ignored private locations. Before export, review all included prompt text, identifiers, summaries, and receipts for private information and redistribution rights. --reviewed records that review; it is not automatic redaction. Report synthetic runs, identity controls, regressions, and limitations honestly.

Prepare a reviewable configuration and evidence package. Do not publish, open a PR, merge, install a candidate, or change shared or production defaults without explicit instruction. Accepted configurations become manually reviewed, versioned baselines; later tuning requires a fresh holdout.

Use the contributor's Git identity. Never add AI attribution trailers or generated-by footers to commits, pull requests, issues, or comments. Preserve human co-authors and sign-offs.
`;
}
