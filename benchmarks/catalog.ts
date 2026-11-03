/** Reviewed benchmark availability. Listing an entry never installs or runs it. */
export interface BenchmarkCatalogEntry {
  readonly id: string;
  readonly status: 'implemented' | 'not-implemented';
  readonly taskCount?: number;
  readonly version?: string;
  readonly source: string;
  readonly description: string;
  readonly requirements: readonly string[];
}

const catalog: readonly BenchmarkCatalogEntry[] = Object.freeze([
  {
    id: 'swe-bench', status: 'implemented' as const,
    source: 'https://github.com/SWE-bench/SWE-bench',
    description: 'SWE-bench, Lite, and Verified: pinned local tasks, existing coding agents, and official Docker grading.',
    requirements: [
      'Reviewed local source export, explicit disjoint partitions, and pinned repository bases.',
      'Pinned compatible official harness, Python dependencies, Docker, and pre-provisioned instance images.',
      'Explicit metered existing-agent and proposer adapters; no inference is run by listing benchmarks.',
    ],
  },
  {
    id: 'frontier-code', status: 'not-implemented' as const, taskCount: 100, version: '1.1',
    source: 'https://cognition.com/blog/frontier-code-1.1',
    description: 'Main has 100 tasks; Extended has 150. Tasks are not publicly released. No Evopt adapter.',
    requirements: [
      'Authorized access to Cognition task environments and the complete versioned grader.',
      'Rubric, blocker, weighted-score, and fair-internet-use verification fidelity.',
      'Explicit accounting for model-based grading and any evaluator fees; weighted scores are outside the current accuracy-only objective.',
    ],
  },
  {
    id: 'terminal-bench', status: 'not-implemented' as const, taskCount: 66, version: '4.0.0',
    source: 'https://github.com/harbor-framework/terminal-bench/releases/tag/v4.0.0',
    description: 'Public Harbor terminal tasks with environment verifiers. No Evopt adapter.',
    requirements: [
      'Pinned task release, Harbor version, environment/verifier images, and task resource settings.',
      'Existing isolated terminal-agent adapter, including GPU resources where required and complete usage receipts.',
      'Trajectory capture and explicitly metered model-based integrity review before claiming leaderboard-equivalent scores.',
    ],
  },
  {
    id: 'swe-atlas-qna-aa', status: 'not-implemented' as const, taskCount: 124,
    version: '1f28d51b6e191e9f2bfdc22b09d92eecdab6654e',
    source: 'https://huggingface.co/datasets/ArtificialAnalysis/SWE-Atlas-QnA-AA',
    description: 'Public repository Q&A tasks with Artificial Analysis rubric grading. No Evopt adapter.',
    requirements: [
      'Pinned AA task/rubric/config revision, repository commits, and isolated task images.',
      'GPT-6 Luna xhigh judge, five votes per criterion, structured verdicts, and recorded answer dates.',
      'Metered judge reservations, bounded retries, and resumable vote evidence inside the optimization USD ceiling; never call a paid judge from the current free scorer.',
    ],
  },
].map(entry => Object.freeze({ ...entry, requirements: Object.freeze(entry.requirements) })));

/** Source assessment is documented in RESEARCH.md; status describes Evopt support. */
export function listBenchmarks(): readonly BenchmarkCatalogEntry[] { return catalog; }
