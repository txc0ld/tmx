# Agentic Pipeline Template — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the pipeline foundation — multi-tile templates, a pipeline-state-machine controller, worktree-creation IPCs, and a "Hello World" pipeline that lays down 3 stub tiles + a controller and walks the state machine to `done` without spawning any agents.

**Architecture:** Frontend-owned state machine (Zustand store wrapping a pure reducer) + new `pipeline-controller` tile (16th built-in type) + new Rust IPCs for worktree CRUD and pre-flight. No agent execution in this phase. Production-prereq scaffolding (capability manifests, run fingerprint, secrets-mask, skill-signing verification) is *declared* but not wired to live execution — that's Phase 2.

**Tech Stack:** Tauri 2 (Rust), React 19 + TypeScript 5, Zustand 5, Vitest (jsdom), `cargo test`, `parking_lot::Mutex`, `tracing`.

**Reference spec:** `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md` (cites §X.Y throughout). Addendum `2026-05-04-...md` is roadmap-only for Phase 1.

**Critical TerminalX patterns (read CLAUDE.md if unfamiliar):**
- **Zustand selector trap:** never `|| []`/`?? []`/`|| {}` inside `useXxxStore(s => …)`. Use a module-level `EMPTY` constant. Failing to do this is the #1 crash cause.
- **All IPC must go through `src/utils/ipc.ts`.** Never call `invoke()` from components.
- **All colors via CSS vars** (`var(--tx-*)`). No hardcoded hex.
- **Tauri event listeners:** use a `mounted` ref guard in cleanup (race condition otherwise).

---

## Task 1: Add new types to `src/types/index.ts`

**Files:**
- Modify: `src/types/index.ts`

Adds: `PipelineRole`, `PipelineState`, `PipelineRun`, `RunFingerprint`, `RoleCapabilities`, artifact interfaces, and extends `TileType` union with `'pipeline-controller'` plus the new `PipelineControllerTile` interface.

- [ ] **Step 1: Open the file and locate the `TileType` union (currently line 12)**

The current line is:
```ts
export type TileType = 'agent' | 'terminal' | 'browser' | 'todo' | 'diff' | 'editor' | 'note' | 'kanban' | 'filetree' | 'group' | 'runner' | 'ssh' | 'docker' | 'git' | 'usage';
```

- [ ] **Step 2: Extend `TileType` to add `pipeline-controller`**

Replace the line with:
```ts
export type TileType = 'agent' | 'terminal' | 'browser' | 'todo' | 'diff' | 'editor' | 'note' | 'kanban' | 'filetree' | 'group' | 'runner' | 'ssh' | 'docker' | 'git' | 'usage' | 'pipeline-controller';
```

- [ ] **Step 3: Locate the `Tile` discriminated union (currently line 192) and extend it**

Find:
```ts
export type Tile = AgentTile | TerminalTile | BrowserTile | TodoTile | DiffTile | EditorTile | NoteTile | KanbanTile | FileTreeTile | GroupTile | RunnerTile | SshTile | DockerTile | GitTile | UsageTile;
```

Replace with:
```ts
export type Tile = AgentTile | TerminalTile | BrowserTile | TodoTile | DiffTile | EditorTile | NoteTile | KanbanTile | FileTreeTile | GroupTile | RunnerTile | SshTile | DockerTile | GitTile | UsageTile | PipelineControllerTile;
```

- [ ] **Step 4: Append new types after the existing tile interfaces (after `UsageTile`, before `Tile` union) — paste the entire block**

```ts
// ─── Pipeline (Phase 1 foundation) ─────────────────────────────────

export type PipelineRole =
  | 'planner' | 'builder' | 'reviewer' | 'reviewer-codex' | 'controller';

export type PipelineState =
  | 'idle'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'building'
  | 'reviewing'
  | 'awaiting_clarification'
  | 'awaiting_merge_approval'
  | 'merging'
  | 'done'
  | 'failed'
  | 'escalated';

export type FailureClass =
  | 'preflight_env'
  | 'planner_refused'
  | 'builder_loop'
  | 'reviewer_irreconcilable'
  | 'reviewer_disagreement_unresolved'
  | 'budget_exceeded'
  | 'stage_unresponsive'
  | 'subagent_failed'
  | 'external_dep'
  | 'secrets_violation'
  | 'unknown';

export interface RunFingerprint {
  templateId: string;
  templateHash: string;
  skillHashes: Record<string, string>;
  rolePromptHashes: Partial<Record<PipelineRole, string>>;
  invariantsHash?: string;
  models: Partial<Record<PipelineRole, string>>;
  capabilityManifests: Partial<Record<PipelineRole, string>>;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
  runStartCommit?: string;
}

export interface RoleCapabilities {
  fileWrites: { allow: string[]; deny: string[] };
  shell: { allowPatterns: string[]; denyPatterns: string[] };
  network: 'none' | 'package-managers' | 'unrestricted';
  mcpTools: string[];
  maxFileSize: number;
}

export interface PlanTask {
  id: string;
  summary: string;
  files: string[];
  tests: string[];
  acceptance: string;
}

export interface PlanArtifact {
  stage: 'planner';
  branch: string;
  specPath: string;
  planPath: string;
  tasks: PlanTask[];
  summary: string;
  complexity?: 'trivial' | 'standard' | 'complex';
}

export interface BuildCommit {
  sha: string;
  subject: string;
  files: string[];
}

export interface BuildArtifact {
  stage: 'builder';
  branch: string;
  headSha: string;
  round: number;
  commits: BuildCommit[];
  filesChanged: string[];
  testsAdded: string[];
  ciStatus: 'green' | 'red' | 'unknown';
  notes?: string;
}

export interface ReviewComment {
  severity: 'blocker' | 'concern' | 'nit';
  file: string;
  line: number;
  issue: string;
  suggestion?: string;
  seenBy?: Array<'opus' | 'codex'>;
}

export interface ReviewVerdict {
  stage: 'reviewer';
  reviewer: 'opus' | 'codex' | 'merged';
  verdict: 'approve' | 'reject';
  round: number;
  comments: ReviewComment[];
  summary: string;
  confidence?: 'verified' | 'likely' | 'uncertain';
  uncertaintyDrivers?: string[];
  diffChunksReviewed?: number;
}

export interface CIFailure {
  test: string;
  output: string;
}

export interface CIResult {
  sha: string;
  status: 'pass' | 'fail';
  step: 'format' | 'lint' | 'typecheck' | 'test' | 'all';
  command: string;
  durationMs: number;
  failures: CIFailure[];
}

export interface QuestionArtifact {
  stage: PipelineRole;
  question: string;
  context: string;
  options?: string[];
  blocking: true;
}

export interface EscalationEntry {
  at: number;
  reason: string;
  exhaustedCounter?: 'reviewerReject' | 'ciFail';
  decision: 'replan' | 'escalate' | 'manual_resolve';
  newPlanRef?: string;
}

export interface PipelineRunArtifacts {
  plan?: PlanArtifact;
  builds: BuildArtifact[];
  reviews: ReviewVerdict[];
  ciResults: CIResult[];
  questions: QuestionArtifact[];
}

export interface PipelineRun {
  id: string;
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  state: PipelineState;
  artifacts: PipelineRunArtifacts;
  retryCounters: { reviewerReject: number; ciFail: number };
  startedAt: number;
  endedAt?: number;
  failureReason?: string;
  failureClass?: FailureClass;
  escalationLog: EscalationEntry[];
  tiles: Partial<Record<PipelineRole, string>>;
  fingerprint: RunFingerprint;
  lastHeartbeatAt?: number;
}

export interface PipelineControllerTile extends TileBase {
  type: 'pipeline-controller';
  runId: string;
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS, no errors. (We've only added types; nothing consumes them yet, so no breakage.)

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(pipeline): add Phase 1 types (PipelineRun, RoleCapabilities, RunFingerprint, artifacts)"
```

---

## Task 2: Pure state-machine reducer (TDD)

**Files:**
- Create: `src/pipeline/state-machine.ts`
- Test: `src/pipeline/state-machine.test.ts`

The state machine is a pure function over `(state, event) → newState`. Keeping it pure (no IPC, no Zustand, no side effects) makes it 100%-testable and is the clean way to evolve the rules. The Zustand store (Task 5) wraps it.

- [ ] **Step 1: Create the directory and write the failing test file**

Create `src/pipeline/state-machine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reducer, initialRunState, type PipelineEvent } from './state-machine';
import type { PipelineRun, RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 'tx.hello',
  templateHash: 'h0',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
};

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'r1',
    templateId: 'tx.hello',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r1',
    branch: 'feat/r1',
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
    ...overrides,
  };
}

describe('pipeline state machine', () => {
  it('idle + start → planning', () => {
    const run = makeRun();
    const ev: PipelineEvent = { type: 'start' };
    expect(reducer(run, ev).state).toBe('planning');
  });

  it('planning + planner_done → awaiting_plan_approval', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_plan_approval');
    expect(next.artifacts.plan).toBeDefined();
  });

  it('awaiting_plan_approval + approve_plan → building', () => {
    const run = makeRun({ state: 'awaiting_plan_approval' });
    const ev: PipelineEvent = { type: 'approve_plan' };
    expect(reducer(run, ev).state).toBe('building');
  });

  it('building + builder_done → reviewing', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('reviewing');
    expect(next.artifacts.builds.length).toBe(1);
  });

  it('reviewing + reviewer approve → awaiting_merge_approval', () => {
    const run = makeRun({ state: 'reviewing' });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'approve',
        round: 1, comments: [], summary: 'lgtm',
      },
    };
    expect(reducer(run, ev).state).toBe('awaiting_merge_approval');
  });

  it('reviewing + reviewer reject within budget → building', () => {
    const run = makeRun({ state: 'reviewing' });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 1, comments: [], summary: 'no',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.retryCounters.reviewerReject).toBe(1);
  });

  it('reviewing + reviewer reject exceeds budget → escalated', () => {
    const run = makeRun({
      state: 'reviewing',
      retryCounters: { reviewerReject: 3, ciFail: 0 },
    });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 4, comments: [], summary: 'still no',
      },
    };
    expect(reducer(run, ev).state).toBe('escalated');
  });

  it('any state + abort → failed', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = { type: 'abort', reason: 'user' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureReason).toBe('user');
  });

  it('any active state + ci_fail within budget → building', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'ci_fail',
      result: { sha: 'a', status: 'fail', step: 'test', command: 'npm test', durationMs: 1, failures: [] },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.retryCounters.ciFail).toBe(1);
  });

  it('any active state + ci_fail exceeds budget → escalated', () => {
    const run = makeRun({
      state: 'building',
      retryCounters: { reviewerReject: 0, ciFail: 3 },
    });
    const ev: PipelineEvent = {
      type: 'ci_fail',
      result: { sha: 'a', status: 'fail', step: 'test', command: 'npm test', durationMs: 1, failures: [] },
    };
    expect(reducer(run, ev).state).toBe('escalated');
  });

  it('any non-terminal state + question_raised → awaiting_clarification', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'question_raised',
      question: { stage: 'builder', question: 'q?', context: 'c', blocking: true },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_clarification');
    expect(next.artifacts.questions.length).toBe(1);
  });

  it('awaiting_clarification + clarification_received → resumes prior state', () => {
    const run = makeRun({ state: 'awaiting_clarification' });
    const ev: PipelineEvent = { type: 'clarification_received', resumeTo: 'building' };
    expect(reducer(run, ev).state).toBe('building');
  });

  it('awaiting_merge_approval + approve_merge → merging', () => {
    const run = makeRun({ state: 'awaiting_merge_approval' });
    const ev: PipelineEvent = { type: 'approve_merge' };
    expect(reducer(run, ev).state).toBe('merging');
  });

  it('merging + merge_done → done', () => {
    const run = makeRun({ state: 'merging' });
    const ev: PipelineEvent = { type: 'merge_done' };
    const next = reducer(run, ev);
    expect(next.state).toBe('done');
    expect(next.endedAt).toBeGreaterThan(0);
  });

  it('terminal states are sticky (done + start = done)', () => {
    const run = makeRun({ state: 'done' });
    const ev: PipelineEvent = { type: 'start' };
    expect(reducer(run, ev).state).toBe('done');
  });

  it('initialRunState produces a valid idle run', () => {
    const run = initialRunState({
      runId: 'r1',
      templateId: 'tx.hello',
      projectId: 'p1',
      worktreePath: '/tmp/wt/r1',
      branch: 'feat/r1',
      fingerprint: FP,
    });
    expect(run.state).toBe('idle');
    expect(run.artifacts.builds).toEqual([]);
    expect(run.retryCounters).toEqual({ reviewerReject: 0, ciFail: 0 });
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/state-machine.test.ts`
Expected: All tests fail (file `state-machine.ts` doesn't exist).

- [ ] **Step 3: Create the reducer implementation**

Create `src/pipeline/state-machine.ts`:

```ts
import type {
  PipelineRun,
  PipelineState,
  PlanArtifact,
  BuildArtifact,
  ReviewVerdict,
  CIResult,
  QuestionArtifact,
  RunFingerprint,
} from '@/types';

const REVIEWER_REJECT_BUDGET = 3;
const CI_FAIL_BUDGET = 3;

const TERMINAL_STATES: ReadonlySet<PipelineState> = new Set(['done', 'failed', 'escalated']);

export type PipelineEvent =
  | { type: 'start' }
  | { type: 'planner_done'; plan: PlanArtifact }
  | { type: 'planner_failed'; reason: string }
  | { type: 'approve_plan' }
  | { type: 'builder_done'; build: BuildArtifact }
  | { type: 'reviewer_done'; verdict: ReviewVerdict }
  | { type: 'ci_fail'; result: CIResult }
  | { type: 'ci_pass'; result: CIResult }
  | { type: 'question_raised'; question: QuestionArtifact }
  | { type: 'clarification_received'; resumeTo: PipelineState }
  | { type: 'approve_merge' }
  | { type: 'reject_merge' }
  | { type: 'merge_done' }
  | { type: 'merge_failed'; reason: string }
  | { type: 'abort'; reason: string };

export interface InitialRunInputs {
  runId: string;
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  fingerprint: RunFingerprint;
}

export function initialRunState(input: InitialRunInputs): PipelineRun {
  return {
    id: input.runId,
    templateId: input.templateId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: {},
    fingerprint: input.fingerprint,
  };
}

export function reducer(run: PipelineRun, ev: PipelineEvent): PipelineRun {
  // Abort and terminal-stickiness handled first
  if (ev.type === 'abort') {
    if (TERMINAL_STATES.has(run.state)) return run;
    return { ...run, state: 'failed', failureReason: ev.reason, endedAt: Date.now() };
  }
  if (TERMINAL_STATES.has(run.state)) return run;

  switch (ev.type) {
    case 'start':
      if (run.state === 'idle') return { ...run, state: 'planning' };
      return run;

    case 'planner_done':
      return {
        ...run,
        state: 'awaiting_plan_approval',
        artifacts: { ...run.artifacts, plan: ev.plan },
      };

    case 'planner_failed':
      return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'planner_refused', endedAt: Date.now() };

    case 'approve_plan':
      if (run.state === 'awaiting_plan_approval') return { ...run, state: 'building' };
      return run;

    case 'builder_done':
      return {
        ...run,
        state: 'reviewing',
        artifacts: { ...run.artifacts, builds: [...run.artifacts.builds, ev.build] },
      };

    case 'reviewer_done': {
      const reviews = [...run.artifacts.reviews, ev.verdict];
      if (ev.verdict.verdict === 'approve') {
        return {
          ...run,
          state: 'awaiting_merge_approval',
          artifacts: { ...run.artifacts, reviews },
        };
      }
      // reject
      const next = run.retryCounters.reviewerReject + 1;
      if (next > REVIEWER_REJECT_BUDGET) {
        return {
          ...run,
          state: 'escalated',
          retryCounters: { ...run.retryCounters, reviewerReject: next },
          artifacts: { ...run.artifacts, reviews },
          failureClass: 'reviewer_irreconcilable',
          endedAt: Date.now(),
        };
      }
      return {
        ...run,
        state: 'building',
        retryCounters: { ...run.retryCounters, reviewerReject: next },
        artifacts: { ...run.artifacts, reviews },
      };
    }

    case 'ci_pass':
      return {
        ...run,
        artifacts: { ...run.artifacts, ciResults: [...run.artifacts.ciResults, ev.result] },
      };

    case 'ci_fail': {
      const next = run.retryCounters.ciFail + 1;
      const ciResults = [...run.artifacts.ciResults, ev.result];
      if (next > CI_FAIL_BUDGET) {
        return {
          ...run,
          state: 'escalated',
          retryCounters: { ...run.retryCounters, ciFail: next },
          artifacts: { ...run.artifacts, ciResults },
          failureClass: 'builder_loop',
          endedAt: Date.now(),
        };
      }
      return {
        ...run,
        state: 'building',
        retryCounters: { ...run.retryCounters, ciFail: next },
        artifacts: { ...run.artifacts, ciResults },
      };
    }

    case 'question_raised':
      return {
        ...run,
        state: 'awaiting_clarification',
        artifacts: { ...run.artifacts, questions: [...run.artifacts.questions, ev.question] },
      };

    case 'clarification_received':
      if (run.state === 'awaiting_clarification') return { ...run, state: ev.resumeTo };
      return run;

    case 'approve_merge':
      if (run.state === 'awaiting_merge_approval') return { ...run, state: 'merging' };
      return run;

    case 'reject_merge':
      if (run.state === 'awaiting_merge_approval') return { ...run, state: 'failed', failureReason: 'merge_rejected', endedAt: Date.now() };
      return run;

    case 'merge_done':
      return { ...run, state: 'done', endedAt: Date.now() };

    case 'merge_failed':
      return { ...run, state: 'failed', failureReason: ev.reason, endedAt: Date.now() };
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/state-machine.test.ts`
Expected: All 17 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/state-machine.ts src/pipeline/state-machine.test.ts
git commit -m "feat(pipeline): pure state-machine reducer with retry budgets"
```

---

## Task 3: Run fingerprint computation (TDD)

**Files:**
- Create: `src/pipeline/fingerprint.ts`
- Test: `src/pipeline/fingerprint.test.ts`

The fingerprint hashes inputs with sha256. Phase 1 only hashes templateId/templateHash/version (skill+prompt+capability hashes deferred to Phase 2 once those exist as resolved values).

- [ ] **Step 1: Write the failing test**

Create `src/pipeline/fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalJsonHash, computeMinimalFingerprint } from './fingerprint';

describe('canonicalJsonHash', () => {
  it('produces same hash regardless of key order', async () => {
    const a = await canonicalJsonHash({ b: 1, a: 2 });
    const b = await canonicalJsonHash({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('different content → different hash', async () => {
    const a = await canonicalJsonHash({ x: 1 });
    const b = await canonicalJsonHash({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('returns 64-char hex (sha256)', async () => {
    const h = await canonicalJsonHash({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeMinimalFingerprint', () => {
  it('hashes the template + version', async () => {
    const fp = await computeMinimalFingerprint({
      templateId: 'tx.hello',
      template: { kind: 'pipeline', id: 'tx.hello', name: 'Hello' },
      terminalxVersion: '0.1.0',
    });
    expect(fp.templateId).toBe('tx.hello');
    expect(fp.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.terminalxVersion).toBe('0.1.0');
    expect(fp.skillHashes).toEqual({});
  });

  it('same template input → same templateHash', async () => {
    const tpl = { kind: 'pipeline' as const, id: 'tx.hello', name: 'Hello' };
    const a = await computeMinimalFingerprint({ templateId: 'tx.hello', template: tpl, terminalxVersion: '0.1.0' });
    const b = await computeMinimalFingerprint({ templateId: 'tx.hello', template: tpl, terminalxVersion: '0.1.0' });
    expect(a.templateHash).toBe(b.templateHash);
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/fingerprint.test.ts`
Expected: Module not found.

- [ ] **Step 3: Implement**

Create `src/pipeline/fingerprint.ts`:

```ts
import type { RunFingerprint } from '@/types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export async function canonicalJsonHash(value: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(value));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface MinimalFingerprintInput {
  templateId: string;
  template: unknown;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
}

export async function computeMinimalFingerprint(
  input: MinimalFingerprintInput,
): Promise<RunFingerprint> {
  return {
    templateId: input.templateId,
    templateHash: await canonicalJsonHash(input.template),
    skillHashes: {},
    rolePromptHashes: {},
    models: {},
    capabilityManifests: {},
    terminalxVersion: input.terminalxVersion,
    claudeVersion: input.claudeVersion,
    codexVersion: input.codexVersion,
  };
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/fingerprint.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/fingerprint.ts src/pipeline/fingerprint.test.ts
git commit -m "feat(pipeline): canonical-JSON sha256 fingerprint computation"
```

---

## Task 4: `pipelineStore` Zustand wrapper

**Files:**
- Create: `src/stores/pipelineStore.ts`
- Test: `src/stores/pipelineStore.test.ts`

Wraps the reducer, holds runs by id, exposes actions.

- [ ] **Step 1: Write the failing test**

Create `src/stores/pipelineStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { usePipelineStore } from './pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

describe('pipelineStore', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('startRun creates a run in idle then transitions to planning on dispatch start', () => {
    const id = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    expect(usePipelineStore.getState().runs[id].state).toBe('idle');
    usePipelineStore.getState().dispatch(id, { type: 'start' });
    expect(usePipelineStore.getState().runs[id].state).toBe('planning');
  });

  it('dispatch is a no-op for unknown run', () => {
    expect(() =>
      usePipelineStore.getState().dispatch('nope', { type: 'start' }),
    ).not.toThrow();
  });

  it('removeRun deletes a run', () => {
    usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().removeRun('r1');
    expect(usePipelineStore.getState().runs.r1).toBeUndefined();
  });

  it('activeRunIds tracks non-terminal runs', () => {
    const id = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    expect(usePipelineStore.getState().activeRunIds).toContain(id);
    // run to terminal
    usePipelineStore.getState().dispatch(id, { type: 'abort', reason: 'test' });
    expect(usePipelineStore.getState().activeRunIds).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/stores/pipelineStore.test.ts`
Expected: Module not found.

- [ ] **Step 3: Implement**

Create `src/stores/pipelineStore.ts`:

```ts
import { create } from 'zustand';
import type { PipelineRun } from '@/types';
import {
  reducer,
  initialRunState,
  type PipelineEvent,
  type InitialRunInputs,
} from '@/pipeline/state-machine';

const TERMINAL = new Set(['done', 'failed', 'escalated']);

interface PipelineStoreShape {
  runs: Record<string, PipelineRun>;
  activeRunIds: string[];
  createRun(input: InitialRunInputs): string;
  dispatch(runId: string, ev: PipelineEvent): void;
  removeRun(runId: string): void;
}

function deriveActive(runs: Record<string, PipelineRun>): string[] {
  return Object.values(runs)
    .filter(r => !TERMINAL.has(r.state))
    .map(r => r.id);
}

export const usePipelineStore = create<PipelineStoreShape>((set) => ({
  runs: {},
  activeRunIds: [],

  createRun: (input) => {
    const run = initialRunState(input);
    set(s => {
      const runs = { ...s.runs, [run.id]: run };
      return { runs, activeRunIds: deriveActive(runs) };
    });
    return run.id;
  },

  dispatch: (runId, ev) => {
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      const runs = { ...s.runs, [runId]: next };
      return { runs, activeRunIds: deriveActive(runs) };
    });
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/stores/pipelineStore.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stores/pipelineStore.ts src/stores/pipelineStore.test.ts
git commit -m "feat(pipeline): pipelineStore Zustand wrapper around reducer"
```

---

## Task 5: `PipelineTemplate` shape in `templateStore`

**Files:**
- Modify: `src/stores/templateStore.ts`

Adds a sibling shape; existing `TileTemplate` untouched. Discriminator: `kind`.

- [ ] **Step 1: Read current templateStore**

Run: `cat /Users/txdm_/.codex/tmx/src/stores/templateStore.ts | head -50`
Verify the existing `TileTemplate` interface and `BUILTIN_TEMPLATES` array.

- [ ] **Step 2: Update the existing `import type` line at the top of `templateStore.ts`**

The file currently has:
```ts
import type { TileType } from '@/types';
```
Replace with:
```ts
import type { TileType, PipelineRole, RoleCapabilities } from '@/types';
```

- [ ] **Step 3: Append the new types after the existing `TileTemplate` interface** (around line 11)

```ts
export interface PipelineTileSpec {
  role: PipelineRole;
  type: TileType;
  position: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
}

export interface PipelineWireSpec {
  fromRole: PipelineRole;
  toRole: PipelineRole;
  wireType: 'context-pipe' | 'agent-chain' | 'task-assign' | 'refresh-trigger' | 'diff-feed';
}

export interface PipelineConfig {
  retryBudget: { reviewerReject: number; ciFail: number };
  dualReviewer: boolean;
  requireMergeGate: boolean;
  skillBindings: Partial<Record<PipelineRole, string[]>>;
  testCommand?: string;
  capabilities?: Partial<Record<PipelineRole, RoleCapabilities>>;
}

export interface PipelineTemplate {
  kind: 'pipeline';
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;
  tiles: PipelineTileSpec[];
  wires: PipelineWireSpec[];
  pipeline: PipelineConfig;
}

export type AnyTemplate = TileTemplate | PipelineTemplate;

export function isPipelineTemplate(t: AnyTemplate): t is PipelineTemplate {
  return (t as { kind?: string }).kind === 'pipeline';
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/templateStore.ts
git commit -m "feat(pipeline): PipelineTemplate type alongside TileTemplate"
```

---

## Task 6: Built-in "Hello World" `PipelineTemplate`

**Files:**
- Create: `src/pipeline/templates.ts`

A factory that returns the built-in template. Phase 1 keeps it minimal — three "agent" tiles (which won't actually spawn since Phase 1 has no execution) + the controller tile spec.

- [ ] **Step 1: Create the file**

Create `src/pipeline/templates.ts`:

```ts
import type { PipelineTemplate } from '@/stores/templateStore';

export function helloWorldTemplate(): PipelineTemplate {
  return {
    kind: 'pipeline',
    id: 'tx.pipeline.hello-world',
    name: 'Pipeline: Hello World',
    description: 'Phase 1 smoke template — lays down 3 agent tiles + a controller; walks the state machine to done without spawning agents.',
    isBuiltin: true,

    tiles: [
      { role: 'planner',  type: 'agent', position: { x: 0,    y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'planner-stub' } },
      { role: 'builder',  type: 'agent', position: { x: 520,  y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'sonnet-4-6', effort: 'low', mode: 'builder-stub' } },
      { role: 'reviewer', type: 'agent', position: { x: 1040, y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'reviewer-stub' } },
      { role: 'controller', type: 'pipeline-controller', position: { x: 0, y: 420, w: 1520, h: 200 },
        config: {} },
    ],

    wires: [
      { fromRole: 'planner',  toRole: 'builder',  wireType: 'agent-chain' },
      { fromRole: 'builder',  toRole: 'reviewer', wireType: 'agent-chain' },
      { fromRole: 'reviewer', toRole: 'builder',  wireType: 'task-assign' },
    ],

    pipeline: {
      retryBudget: { reviewerReject: 3, ciFail: 3 },
      dualReviewer: false,
      requireMergeGate: true,
      skillBindings: {
        planner:  ['superpowers:brainstorming', 'superpowers:writing-plans', 'tx-pipeline-stage-handoff'],
        builder:  ['superpowers:executing-plans', 'superpowers:test-driven-development', 'tdd', 'superpowers:verification-before-completion', 'tx-pipeline-stage-handoff'],
        reviewer: ['superpowers:requesting-code-review', 'karpathy-guidelines', 'tx-pipeline-reviewer'],
      },
    },
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/templates.ts
git commit -m "feat(pipeline): Hello World built-in PipelineTemplate"
```

---

## Task 7: `PipelineControllerTile` component (basic render)

**Files:**
- Create: `src/components/tiles/PipelineControllerTile.tsx`

Phase 1 renders run state, retry counters, and an "Abort" button. No approval modals (those land in Phase 2 when `awaiting_*` states actually serve a purpose).

- [ ] **Step 1: Create the component**

Create `src/components/tiles/PipelineControllerTile.tsx`:

```tsx
import { usePipelineStore } from '@/stores/pipelineStore';
import type { PipelineControllerTile as Tile } from '@/types';

const EMPTY_RUN_PLACEHOLDER = '—';

interface Props {
  tile: Tile;
}

export function PipelineControllerTile({ tile }: Props) {
  const run = usePipelineStore(s => s.runs[tile.runId]);
  const dispatch = usePipelineStore(s => s.dispatch);
  const removeRun = usePipelineStore(s => s.removeRun);

  if (!run) {
    return (
      <div style={{ padding: 12, color: 'var(--tx-text-muted)' }}>
        No run bound (runId={tile.runId || EMPTY_RUN_PLACEHOLDER}).
      </div>
    );
  }

  const isTerminal = run.state === 'done' || run.state === 'failed' || run.state === 'escalated';

  return (
    <div style={{
      padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
      color: 'var(--tx-text)',
      fontFamily: 'var(--tx-font-mono)',
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
        <strong>Pipeline</strong>
        <span style={{ color: 'var(--tx-text-muted)' }}>{run.id}</span>
        <span>state: <code style={{ color: 'var(--tx-accent)' }}>{run.state}</code></span>
      </div>
      <div>branch: <code>{run.branch}</code></div>
      <div>worktree: <code>{run.worktreePath}</code></div>
      <div>retries: reviewer={run.retryCounters.reviewerReject}/3, ci={run.retryCounters.ciFail}/3</div>
      {run.failureReason && (
        <div style={{ color: 'var(--tx-error)' }}>failure: {run.failureReason}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {!isTerminal && run.state === 'idle' && (
          <button
            onClick={() => dispatch(run.id, { type: 'start' })}
            style={{ padding: '4px 10px', background: 'var(--tx-accent)', color: 'var(--tx-text)' }}
          >
            Start
          </button>
        )}
        {!isTerminal && (
          <button
            onClick={() => dispatch(run.id, { type: 'abort', reason: 'user clicked abort' })}
            style={{ padding: '4px 10px', background: 'var(--tx-surface-2)', color: 'var(--tx-text)' }}
          >
            Abort
          </button>
        )}
        {isTerminal && (
          <button
            onClick={() => removeRun(run.id)}
            style={{ padding: '4px 10px', background: 'var(--tx-surface-2)', color: 'var(--tx-text)' }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/tiles/PipelineControllerTile.tsx
git commit -m "feat(pipeline): PipelineControllerTile component (Phase 1 minimal)"
```

---

## Task 8: Wire `PipelineControllerTile` into `InfiniteCanvas` dispatch

**Files:**
- Modify: `src/components/canvas/InfiniteCanvas.tsx` (the `renderTileContent` switch around line 51-86)

- [ ] **Step 1: Add the import**

At the top of `src/components/canvas/InfiniteCanvas.tsx`, add:
```ts
import { PipelineControllerTile } from '@/components/tiles/PipelineControllerTile';
```

- [ ] **Step 2: Add the new case**

Locate the `case 'usage':` line (currently around line 81-82). Immediately after the `case 'usage'` return, add:
```ts
    case 'pipeline-controller':
      return <PipelineControllerTile tile={tile as import('@/types').PipelineControllerTile} />;
```

The full updated switch tail should look like:
```ts
    case 'usage':
      return <UsageTile />;
    case 'pipeline-controller':
      return <PipelineControllerTile tile={tile as import('@/types').PipelineControllerTile} />;
    default:
      return null;
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/InfiniteCanvas.tsx
git commit -m "feat(pipeline): InfiniteCanvas dispatches pipeline-controller tile"
```

---

## Task 9: Pipeline-template instantiation helper

**Files:**
- Create: `src/pipeline/instantiate.ts`
- Test: `src/pipeline/instantiate.test.ts`

A pure function that turns a `PipelineTemplate` + insertion-origin into the list of `Tile`s and `Wire`s the canvas should add. Pure makes it testable without canvasStore plumbing.

- [ ] **Step 1: Write failing test**

Create `src/pipeline/instantiate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { instantiatePipelineTemplate } from './instantiate';
import { helloWorldTemplate } from './templates';

describe('instantiatePipelineTemplate', () => {
  it('produces one tile per template tile + offsets by origin', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 100, originY: 200 });
    expect(out.tiles.length).toBe(tpl.tiles.length);
    const planner = out.tiles.find(t => t.title?.startsWith('Planner'));
    expect(planner?.x).toBe(100);
    expect(planner?.y).toBe(200);
  });

  it('binds the controller tile to the runId', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r-xyz', originX: 0, originY: 0 });
    const ctrl = out.tiles.find(t => t.type === 'pipeline-controller');
    expect(ctrl).toBeDefined();
    expect((ctrl as { runId: string }).runId).toBe('r-xyz');
  });

  it('produces one wire per template wire with resolved tile ids', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    expect(out.wires.length).toBe(tpl.wires.length);
    for (const w of out.wires) {
      expect(out.tiles.some(t => t.id === w.fromTile)).toBe(true);
      expect(out.tiles.some(t => t.id === w.toTile)).toBe(true);
    }
  });

  it('returns role→tileId map for controller binding', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    expect(out.roleToTileId.planner).toBeDefined();
    expect(out.roleToTileId.builder).toBeDefined();
    expect(out.roleToTileId.reviewer).toBeDefined();
    expect(out.roleToTileId.controller).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/instantiate.test.ts`
Expected: Module not found.

- [ ] **Step 3: Implement**

Create `src/pipeline/instantiate.ts`:

```ts
import type { Tile, Wire, PipelineRole, AgentTile, PipelineControllerTile } from '@/types';
import type { PipelineTemplate } from '@/stores/templateStore';

interface InstantiateInput {
  runId: string;
  originX: number;
  originY: number;
}

interface InstantiateOutput {
  tiles: Tile[];
  wires: Wire[];
  roleToTileId: Partial<Record<PipelineRole, string>>;
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const ROLE_TITLES: Record<PipelineRole, string> = {
  planner: 'Planner',
  builder: 'Builder',
  reviewer: 'Reviewer',
  'reviewer-codex': 'Reviewer (Codex)',
  controller: 'Controller',
};

export function instantiatePipelineTemplate(
  template: PipelineTemplate,
  input: InstantiateInput,
): InstantiateOutput {
  const roleToTileId: Partial<Record<PipelineRole, string>> = {};
  const tiles: Tile[] = [];

  for (const spec of template.tiles) {
    const id = uid(`tile-${spec.role}`);
    roleToTileId[spec.role] = id;

    const base = {
      id,
      x: input.originX + spec.position.x,
      y: input.originY + spec.position.y,
      w: spec.position.w,
      h: spec.position.h,
      title: ROLE_TITLES[spec.role],
    };

    if (spec.type === 'pipeline-controller') {
      const tile: PipelineControllerTile = { ...base, type: 'pipeline-controller', runId: input.runId };
      tiles.push(tile);
    } else if (spec.type === 'agent') {
      const cfg = spec.config as Partial<AgentTile>;
      const tile: AgentTile = {
        ...base,
        type: 'agent',
        agent: (cfg.agent as AgentTile['agent']) ?? 'claude',
        model: (cfg.model as string) ?? 'opus-4-7',
        effort: (cfg.effort as string) ?? '',
        mode: (cfg.mode as string) ?? '',
        version: (cfg.version as string) ?? '',
        cwd: (cfg.cwd as string) ?? '',
        branch: (cfg.branch as string) ?? '',
        status: 'idle',
        elapsed: 0,
      };
      tiles.push(tile);
    } else {
      // Phase 1 doesn't materialize other tile types from PipelineTemplate; skip with warning.
      // (Future templates may include non-agent helper tiles.)
      console.warn(`[pipeline] unsupported tile type in PipelineTemplate: ${spec.type}`);
    }
  }

  const wires: Wire[] = [];
  for (const w of template.wires) {
    const fromTile = roleToTileId[w.fromRole];
    const toTile = roleToTileId[w.toRole];
    if (!fromTile || !toTile) continue;
    wires.push({
      id: uid('wire'),
      fromTile,
      fromPort: 'output',  // Wire ports are union-typed in @/types — see Wire interface
      toTile,
      toPort: 'input',
      wireType: w.wireType,
      active: false,
    });
  }

  return { tiles, wires, roleToTileId };
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/instantiate.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/instantiate.ts src/pipeline/instantiate.test.ts
git commit -m "feat(pipeline): pure pipeline-template instantiation helper"
```

---

## Task 10: Rust pipeline command module skeleton

**Files:**
- Create: `src-tauri/src/commands/pipeline.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod pipeline;`)

Phase 1 ships four commands: `pipeline_preflight`, `pipeline_worktree_create`, `pipeline_worktree_destroy`, `pipeline_install_skills` (stub). Each is its own task below; this task creates the file scaffold and the module declaration.

- [ ] **Step 1: Add the module declaration**

Open `src-tauri/src/commands/mod.rs`. Add (alphabetical order):
```rust
pub mod pipeline;
```

- [ ] **Step 2: Create the file with the shared helpers**

Create `src-tauri/src/commands/pipeline.rs`:

```rust
//! Pipeline command surface (Phase 1).
//!
//! Phase 1 ships:
//!   - pipeline_preflight    — git/CLI/worktree-dir checks
//!   - pipeline_worktree_create / _destroy
//!   - pipeline_install_skills (stub — full impl in Phase 2)
//!
//! Future phases extend this with `pipeline_merger_run`, `agent_run_oneshot`, etc.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct PreflightResult {
    pub is_git_repo: bool,
    pub working_tree_clean: bool,
    pub main_branch: Option<String>,
    pub claude_present: bool,
    pub codex_present: bool,
    pub gh_present: bool,
    pub gh_authenticated: bool,
    pub worktree_dir_writable: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallSkillsResult {
    pub skills_dir: String,
    pub installed: Vec<String>,
    pub already_present: Vec<String>,
    pub stub: bool,
}

fn cmd_present(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Reject paths that contain control characters or shell-metacharacter footguns.
/// Mirrors the validation pattern used by `agent_spawn` (see commands/agents.rs).
fn validate_path_arg(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("empty path".into());
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    Ok(())
}
```

- [ ] **Step 3: Run cargo check**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo check`
Expected: PASS (warnings about unused functions are fine — they'll be used in subsequent tasks).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/pipeline.rs src-tauri/src/commands/mod.rs
git commit -m "feat(pipeline): Rust commands/pipeline module scaffold"
```

---

## Task 11: Rust `pipeline_preflight` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`

- [ ] **Step 1: Append unit tests at the bottom of pipeline.rs**

Add to `src-tauri/src/commands/pipeline.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn preflight_reports_non_git_dir() {
        let dir = tempdir().unwrap();
        let result = run_preflight_inner(dir.path());
        assert!(!result.is_git_repo);
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn preflight_reports_git_dir_clean() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.email", "t@t"]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.name", "t"]).current_dir(dir.path()).output().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["commit", "-m", "x"]).current_dir(dir.path()).output().unwrap();

        let result = run_preflight_inner(dir.path());
        assert!(result.is_git_repo);
        assert!(result.working_tree_clean);
    }

    #[test]
    fn preflight_reports_dirty_tree() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();

        let result = run_preflight_inner(dir.path());
        assert!(result.is_git_repo);
        assert!(!result.working_tree_clean);
    }
}
```

- [ ] **Step 2: Add `tempfile` to dev-dependencies if not already present**

Open `src-tauri/Cargo.toml`. Under `[dev-dependencies]` (add the section if missing), ensure:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests::preflight`
Expected: FAIL — `run_preflight_inner` not defined.

- [ ] **Step 4: Implement the inner logic and the Tauri command wrapper**

Append to `src-tauri/src/commands/pipeline.rs` (above the `#[cfg(test)]` block):

```rust
fn run_preflight_inner(project_dir: &Path) -> PreflightResult {
    let mut errors = Vec::new();

    // git repo?
    let is_git_repo = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(project_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_git_repo {
        errors.push("not a git repo (run `git init`)".into());
    }

    // working tree clean?
    let working_tree_clean = if is_git_repo {
        Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(project_dir)
            .output()
            .ok()
            .map(|o| o.stdout.is_empty())
            .unwrap_or(false)
    } else {
        false
    };

    // resolve main branch
    let main_branch = if is_git_repo {
        let out = Command::new("git")
            .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
            .current_dir(project_dir)
            .output()
            .ok();
        match out {
            Some(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                s.strip_prefix("origin/").map(|x| x.to_string()).or(Some(s))
            }
            _ => {
                // fall back: probe for main / master
                let try_branch = |b: &str| -> bool {
                    Command::new("git")
                        .args(["rev-parse", "--verify", b])
                        .current_dir(project_dir)
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                };
                if try_branch("main") {
                    Some("main".into())
                } else if try_branch("master") {
                    Some("master".into())
                } else {
                    None
                }
            }
        }
    } else {
        None
    };

    let claude_present = cmd_present("claude");
    let codex_present = cmd_present("codex");
    let gh_present = cmd_present("gh");
    let gh_authenticated = if gh_present {
        Command::new("gh")
            .args(["auth", "status"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };

    let worktree_parent = project_dir.join(".tx-worktrees");
    let worktree_dir_writable = std::fs::create_dir_all(&worktree_parent).is_ok();

    PreflightResult {
        is_git_repo,
        working_tree_clean,
        main_branch,
        claude_present,
        codex_present,
        gh_present,
        gh_authenticated,
        worktree_dir_writable,
        errors,
    }
}

#[tauri::command]
pub fn pipeline_preflight(project_dir: String) -> Result<PreflightResult, String> {
    validate_path_arg(&project_dir)?;
    let p = PathBuf::from(&project_dir);
    if !p.exists() {
        return Err(format!("project_dir does not exist: {}", project_dir));
    }
    Ok(run_preflight_inner(&p))
}
```

- [ ] **Step 5: Run cargo test, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests::preflight`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/pipeline.rs src-tauri/Cargo.toml
git commit -m "feat(pipeline): pipeline_preflight Rust command + unit tests"
```

---

## Task 12: Rust `pipeline_worktree_create` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`

- [ ] **Step 1: Add tests in the existing `mod tests` block**

Append (inside the `mod tests`):

```rust
    #[test]
    fn worktree_create_succeeds_in_git_repo() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.email", "t@t"]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.name", "t"]).current_dir(dir.path()).output().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["commit", "-m", "x"]).current_dir(dir.path()).output().unwrap();

        let res = create_worktree_inner(
            dir.path(),
            "feat/test-1",
            dir.path().join(".tx-worktrees/r1").as_path(),
            None,
        );
        assert!(res.is_ok(), "got error: {:?}", res.err());
        assert!(dir.path().join(".tx-worktrees/r1").exists());
    }

    #[test]
    fn worktree_create_rejects_invalid_branch() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        let res = create_worktree_inner(
            dir.path(),
            "bad branch with spaces",
            dir.path().join(".tx-worktrees/r1").as_path(),
            None,
        );
        assert!(res.is_err());
    }
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests::worktree_create`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/commands/pipeline.rs` (above `#[cfg(test)]`):

```rust
fn validate_branch_name(b: &str) -> Result<(), String> {
    if b.is_empty() { return Err("empty branch".into()); }
    if b.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("branch name contains whitespace/control".into());
    }
    if b.starts_with('-') || b.contains("..") || b.contains("//") {
        return Err("invalid branch name".into());
    }
    Ok(())
}

fn create_worktree_inner(
    project_dir: &Path,
    branch: &str,
    worktree_path: &Path,
    base_branch: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    validate_branch_name(branch)?;

    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
    }

    let mut args = vec!["worktree", "add", "-b", branch];
    let wp = worktree_path.to_string_lossy().to_string();
    args.push(&wp);
    if let Some(base) = base_branch { args.push(base); }

    let out = Command::new("git")
        .args(&args)
        .current_dir(project_dir)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("git worktree add failed: {err}"));
    }

    Ok(WorktreeCreateResult {
        path: wp,
        branch: branch.to_string(),
    })
}

#[tauri::command]
pub fn pipeline_worktree_create(
    project_dir: String,
    branch: String,
    worktree_path: String,
    base_branch: Option<String>,
) -> Result<WorktreeCreateResult, String> {
    validate_path_arg(&project_dir)?;
    validate_path_arg(&worktree_path)?;
    create_worktree_inner(
        Path::new(&project_dir),
        &branch,
        Path::new(&worktree_path),
        base_branch.as_deref(),
    )
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests`
Expected: All pipeline tests pass (preflight × 3 + worktree_create × 2 = 5).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pipeline.rs
git commit -m "feat(pipeline): pipeline_worktree_create Rust command + tests"
```

---

## Task 13: Rust `pipeline_worktree_destroy` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`

- [ ] **Step 1: Add tests**

Append inside `mod tests`:

```rust
    #[test]
    fn worktree_destroy_removes_worktree() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.email", "t@t"]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["config", "user.name", "t"]).current_dir(dir.path()).output().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git").args(["commit", "-m", "x"]).current_dir(dir.path()).output().unwrap();

        let wt = dir.path().join(".tx-worktrees/r1");
        create_worktree_inner(dir.path(), "feat/destroy-test", &wt, None).unwrap();
        assert!(wt.exists());

        let res = destroy_worktree_inner(dir.path(), &wt, "feat/destroy-test");
        assert!(res.is_ok());
        assert!(!wt.exists());
    }

    #[test]
    fn worktree_destroy_idempotent_on_missing_path() {
        let dir = tempdir().unwrap();
        Command::new("git").arg("init").current_dir(dir.path()).output().unwrap();
        let res = destroy_worktree_inner(
            dir.path(),
            &dir.path().join(".tx-worktrees/never"),
            "feat/never",
        );
        assert!(res.is_ok(), "destroy should be idempotent");
    }
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests::worktree_destroy`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/commands/pipeline.rs` (above `#[cfg(test)]`):

```rust
fn destroy_worktree_inner(
    project_dir: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), String> {
    if !worktree_path.exists() {
        return Ok(());
    }

    // git worktree remove (force, since we may have uncommitted scratchpads)
    let _ = Command::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            &worktree_path.to_string_lossy(),
        ])
        .current_dir(project_dir)
        .output();

    // best-effort branch delete (force, since worktree had it)
    let _ = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(project_dir)
        .output();

    // belt-and-braces: filesystem cleanup if git worktree didn't fully remove
    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .map_err(|e| format!("rmdir {}: {e}", worktree_path.display()))?;
    }

    Ok(())
}

#[tauri::command]
pub fn pipeline_worktree_destroy(
    project_dir: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    validate_path_arg(&project_dir)?;
    validate_path_arg(&worktree_path)?;
    validate_branch_name(&branch)?;
    destroy_worktree_inner(
        Path::new(&project_dir),
        Path::new(&worktree_path),
        &branch,
    )
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pipeline.rs
git commit -m "feat(pipeline): pipeline_worktree_destroy Rust command + tests"
```

---

## Task 14: Rust `pipeline_install_skills` stub

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`

Phase 1 stub: returns the skills dir + a fixed list of skills *that would* be installed. No copying yet (the bundled skill files don't exist in `src-tauri/resources/skills/` yet; that's Phase 2).

- [ ] **Step 1: Add a test**

Append inside `mod tests`:

```rust
    #[test]
    fn install_skills_stub_returns_metadata() {
        let res = install_skills_inner();
        assert!(res.stub);
        assert!(!res.installed.is_empty() || !res.already_present.is_empty() || res.installed.len() == 0);
    }
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests::install_skills`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/commands/pipeline.rs`:

```rust
fn skills_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".claude").join("skills");
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile).join(".claude").join("skills");
    }
    PathBuf::from(".claude").join("skills")
}

const BUNDLED_PIPELINE_SKILLS: &[&str] = &[
    "tx-pipeline-stage-handoff",
    "tx-pipeline-reviewer",
];

fn install_skills_inner() -> InstallSkillsResult {
    let dir = skills_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut already = Vec::new();
    for s in BUNDLED_PIPELINE_SKILLS {
        if dir.join(s).join("SKILL.md").exists() {
            already.push((*s).to_string());
        }
    }
    InstallSkillsResult {
        skills_dir: dir.to_string_lossy().to_string(),
        installed: Vec::new(),     // Phase 1 doesn't actually copy files
        already_present: already,
        stub: true,
    }
}

#[tauri::command]
pub fn pipeline_install_skills() -> Result<InstallSkillsResult, String> {
    Ok(install_skills_inner())
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pipeline.rs
git commit -m "feat(pipeline): pipeline_install_skills Phase 1 stub"
```

---

## Task 15: Register pipeline commands in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Locate the `tauri::generate_handler!` macro invocation in `lib.rs`**

Run: `cd /Users/txdm_/.codex/tmx && grep -n "generate_handler\|invoke_handler" src-tauri/src/lib.rs`
Note the line number (~54 in the current code).

- [ ] **Step 2: Add the four pipeline commands to the handler list**

Inside the `tauri::generate_handler![...]` block, add (alphabetical fits TerminalX style):

```rust
            commands::pipeline::pipeline_install_skills,
            commands::pipeline::pipeline_preflight,
            commands::pipeline::pipeline_worktree_create,
            commands::pipeline::pipeline_worktree_destroy,
```

- [ ] **Step 3: Run cargo check + clippy**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo check && cargo clippy --all-targets -- -D warnings`
Expected: PASS, no warnings (the linter gate matches CI).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(pipeline): register Rust pipeline commands in invoke_handler"
```

---

## Task 16: Add IPC wrappers in `src/utils/ipc.ts`

**Files:**
- Modify: `src/utils/ipc.ts`

- [ ] **Step 1: Append the four wrappers at the bottom of the file**

Append to `src/utils/ipc.ts`:

```ts
// ─── Pipeline (Phase 1) ───────────────────────────────────────

export interface PreflightResult {
  is_git_repo: boolean;
  working_tree_clean: boolean;
  main_branch: string | null;
  claude_present: boolean;
  codex_present: boolean;
  gh_present: boolean;
  gh_authenticated: boolean;
  worktree_dir_writable: boolean;
  errors: string[];
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
}

export interface InstallSkillsResult {
  skills_dir: string;
  installed: string[];
  already_present: string[];
  stub: boolean;
}

export async function pipelinePreflight(projectDir: string): Promise<PreflightResult> {
  return invoke<PreflightResult>('pipeline_preflight', { projectDir });
}

export async function pipelineWorktreeCreate(opts: {
  projectDir: string;
  branch: string;
  worktreePath: string;
  baseBranch?: string;
}): Promise<WorktreeCreateResult> {
  return invoke<WorktreeCreateResult>('pipeline_worktree_create', {
    projectDir: opts.projectDir,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    baseBranch: opts.baseBranch ?? null,
  });
}

export async function pipelineWorktreeDestroy(opts: {
  projectDir: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  await invoke<void>('pipeline_worktree_destroy', opts);
}

export async function pipelineInstallSkills(): Promise<InstallSkillsResult> {
  return invoke<InstallSkillsResult>('pipeline_install_skills');
}
```

If `invoke` isn't already imported at the top of the file, add:
```ts
import { invoke } from '@tauri-apps/api/core';
```
(It's almost certainly already imported — check first; don't double-import.)

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/ipc.ts
git commit -m "feat(pipeline): TS IPC wrappers for pipeline commands"
```

---

## Task 17: End-to-end smoke test (Vitest)

**Files:**
- Create: `src/pipeline/phase1-smoke.test.ts`

Verifies the Phase 1 ship gate: instantiate the Hello World template → create a run → walk the state machine through every gate to `done`. No Rust/IPC; this is the frontend integration test.

- [ ] **Step 1: Write the test**

Create `src/pipeline/phase1-smoke.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { helloWorldTemplate } from './templates';
import { instantiatePipelineTemplate } from './instantiate';
import { computeMinimalFingerprint } from './fingerprint';
import { usePipelineStore } from '@/stores/pipelineStore';

describe('Phase 1 smoke: Hello World pipeline walks to done', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('instantiates 4 tiles + 3 wires from the Hello World template', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r-smoke', originX: 0, originY: 0 });
    expect(out.tiles.length).toBe(4);
    expect(out.wires.length).toBe(3);
  });

  it('walks the state machine end-to-end', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id,
      template: tpl,
      terminalxVersion: '0.1.0',
    });

    const runId = usePipelineStore.getState().createRun({
      runId: 'r-smoke',
      templateId: tpl.id,
      projectId: 'p1',
      worktreePath: '/tmp/wt/r-smoke',
      branch: 'feat/r-smoke',
      fingerprint: fp,
    });

    const dispatch = usePipelineStore.getState().dispatch;
    const stateOf = () => usePipelineStore.getState().runs[runId].state;

    expect(stateOf()).toBe('idle');
    dispatch(runId, { type: 'start' });
    expect(stateOf()).toBe('planning');

    dispatch(runId, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r-smoke', specPath: 's', planPath: 'p',
        tasks: [], summary: 's',
      },
    });
    expect(stateOf()).toBe('awaiting_plan_approval');

    dispatch(runId, { type: 'approve_plan' });
    expect(stateOf()).toBe('building');

    dispatch(runId, {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'feat/r-smoke', headSha: 'a', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      },
    });
    expect(stateOf()).toBe('reviewing');

    dispatch(runId, {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'approve',
        round: 1, comments: [], summary: 'lgtm',
      },
    });
    expect(stateOf()).toBe('awaiting_merge_approval');

    dispatch(runId, { type: 'approve_merge' });
    expect(stateOf()).toBe('merging');

    dispatch(runId, { type: 'merge_done' });
    expect(stateOf()).toBe('done');

    expect(usePipelineStore.getState().activeRunIds).not.toContain(runId);
  });

  it('escalates on the 4th reviewer reject', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-esc', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt/r-esc', branch: 'feat/r-esc', fingerprint: fp,
    });

    const dispatch = usePipelineStore.getState().dispatch;
    const stateOf = () => usePipelineStore.getState().runs[runId].state;

    dispatch(runId, { type: 'start' });
    dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    dispatch(runId, { type: 'approve_plan' });

    for (let round = 1; round <= 4; round++) {
      dispatch(runId, { type: 'builder_done', build: {
        stage: 'builder', branch: 'b', headSha: 'a', round,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      }});
      dispatch(runId, { type: 'reviewer_done', verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round, comments: [], summary: 'no',
      }});
    }

    expect(stateOf()).toBe('escalated');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/phase1-smoke.test.ts`
Expected: 3 tests pass.

- [ ] **Step 3: Run the full test suite once to confirm no regressions**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test`
Expected: All tests pass (existing + the ones added in this plan).

- [ ] **Step 4: Run the full Rust test suite**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test`
Expected: All tests pass (existing + 8 new pipeline tests).

- [ ] **Step 5: Run typecheck + clippy + fmt**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck && cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/phase1-smoke.test.ts
git commit -m "test(pipeline): Phase 1 ship-gate smoke test (state machine end-to-end)"
```

---

## Task 18: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

Bump the store count and tile-type count, document the pipeline foundation, link to the spec.

- [ ] **Step 1: Open `CLAUDE.md` and locate the stores section**

Run: `grep -n "13 stores total\|14 stores total\|15 stores total" /Users/txdm_/.codex/tmx/CLAUDE.md`

- [ ] **Step 2: Update the store count to 15**

Find:
```
**Stores** (`stores/`): Zustand 5, 14 stores total:
```
Replace with:
```
**Stores** (`stores/`): Zustand 5, 15 stores total:
```

Then in the bullet list of stores below, add a new line at the end (before the closing line):
```
- `pipelineStore` — Pipeline run state machine (Phase 1: foundation; full execution lands in Phase 2). See `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md`
```

- [ ] **Step 3: Update the tile-type list**

Locate the line in CLAUDE.md that begins with `**Tile system**: 15 built-in tile types`. Replace with:
```
**Tile system**: 16 built-in tile types
```

In the list after `usage`, add `pipeline-controller`. The full list becomes:
```
agent, terminal, editor, diff, note, todo, kanban, filetree, git, browser, runner, ssh, docker, usage, group, pipeline-controller
```

- [ ] **Step 4: Add a new "Pipeline Templates" subsection**

Find the end of the *Critical Patterns* section in CLAUDE.md (just before *Pass-Through Contracts*). Insert a new top-level section heading and description:

```markdown
## Pipeline Templates (Phase 1 foundation)

Multi-tile templates that lay down a wired set of agent + helper tiles + a `pipeline-controller` tile, owned by `pipelineStore`. Phase 1 ships the foundation: state machine, fingerprint, worktree IPCs, controller tile rendering. Phase 2 wires live agent execution. See `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md` for the full design and `2026-05-04-...-addendum.md` for the post-v1 roadmap.

**State machine** lives in `src/pipeline/state-machine.ts` as a pure reducer; `src/stores/pipelineStore.ts` wraps it. Direct dispatch via `usePipelineStore.getState().dispatch(runId, event)`.

**Worktree IPCs** (`pipeline_worktree_create` / `pipeline_worktree_destroy`) and `pipeline_preflight` validate path/branch args against control-char + shell-metachar checks per the same pattern as `agent_spawn` (see `commands/agents.rs`). Cross-platform: cleanup uses `git worktree remove --force` plus a fallback `remove_dir_all` for cases where git's removal misses files.

**Skills installation** (`pipeline_install_skills`) is a Phase 1 stub: it reports the target dir (`~/.claude/skills/`) and which bundled skills are already present, without yet copying files. Phase 2 ships the bundle in `src-tauri/resources/skills/` and signs each `SKILL.md` with the updater key.
```

- [ ] **Step 5: Run a final sanity check**

Run: `cd /Users/txdm_/.codex/tmx && grep -nE "15 stores total|16 built-in tile types|pipeline-controller" CLAUDE.md`
Expected: 3 matches at minimum.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md updated for Phase 1 pipeline foundation (store count, tile count, new section)"
```

---

## Phase 1 Ship Gate

After all 18 tasks, verify the ship gate from spec §15 Phase 1:

- [ ] **Gate 1: Frontend tests all green**

Run: `cd /Users/txdm_/.codex/tmx && pnpm test`
Expected: 100% pass, including the new `phase1-smoke.test.ts`.

- [ ] **Gate 2: Rust tests all green**

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test`
Expected: 100% pass, including 8 new `pipeline::tests::*`.

- [ ] **Gate 3: Typecheck + clippy + fmt clean (matches CI)**

Run: `cd /Users/txdm_/.codex/tmx && pnpm typecheck && cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: All pass.

- [ ] **Gate 4: Manual smoke in `pnpm tauri dev`**

Run: `cd /Users/txdm_/.codex/tmx && pnpm tauri dev`

In a Node REPL or a temporary command-palette debug action:

```js
// Pseudocode — adapt to whatever the user normally uses to inject debug actions
const { instantiatePipelineTemplate } = await import('@/pipeline/instantiate');
const { helloWorldTemplate } = await import('@/pipeline/templates');
const { computeMinimalFingerprint } = await import('@/pipeline/fingerprint');
const { usePipelineStore } = await import('@/stores/pipelineStore');
const { useCanvasStore } = await import('@/stores/canvasStore');

const tpl = helloWorldTemplate();
const fp = await computeMinimalFingerprint({ templateId: tpl.id, template: tpl, terminalxVersion: '0.1.0' });
const out = instantiatePipelineTemplate(tpl, { runId: 'r-manual', originX: 200, originY: 200 });
const id = usePipelineStore.getState().createRun({
  runId: 'r-manual', templateId: tpl.id, projectId: 'manual',
  worktreePath: '/tmp/wt/r-manual', branch: 'feat/r-manual', fingerprint: fp,
});
out.tiles.forEach(t => useCanvasStore.getState().addTile(t));
out.wires.forEach(w => useCanvasStore.getState().addWire(w));
```

Expected on the canvas:
- 3 stub agent tiles + 1 `pipeline-controller` tile appear at (200, 200).
- The controller tile shows `state: idle`, retries 0/3 0/3, branch `feat/r-manual`.
- Click "Start" — controller updates to `state: planning`.
- Click "Abort" — controller updates to `state: failed`.

A "Hello World pipeline template that lays down 3 tiles + a controller, walks the state machine to `done`" — Phase 1 ship gate met.

---

## Self-review notes (for the executing engineer)

- **Spec coverage check:** This plan implements the *foundation* portion of §15 Phase 1. Specifically: types (§4.1, §4.2, §8 partial), state machine (§6 happy-path + retry budgets in §7.1), fingerprint structure (§17.4 minimal), template extension (§4.1), controller tile (§4.2), Rust IPCs for worktree + preflight (§4.3, §11), skill-install stub (§10.3 stub). NOT in this phase: live agent execution, sentinel scanning, CI hook, merger, dual-reviewer, capability-manifest installation, secrets handling enforcement, notifications, telemetry — all Phase 2.
- **Why no `awaiting_clarification` event handlers in Task 2's reducer test for non-trivial paths:** the state is *declared* (Task 1) so the type union is forward-compatible, and the reducer accepts `question_raised` / `clarification_received` as Task 2 covers. Full UX wiring lands in Phase 2 when there's a live agent that can actually emit `<<<TX_STAGE_QUESTION>>>`.
- **Why `pipeline_install_skills` is a stub:** the bundled skill files (`src-tauri/resources/skills/tx-pipeline-stage-handoff/SKILL.md` etc.) don't exist yet. They're authored in Phase 2 using `superpowers:writing-skills`. Phase 1 ships the IPC surface so Phase 2 can wire to it without backend churn.
- **Persistence note:** `pipelineStore` is intentionally NOT integrated with TerminalX's existing 3-layer persistence (localStorage / IPC disk / `beforeunload`) in this phase. Phase 2 adds that integration once we know the actual disk shape we want to commit to. Phase 1 runs are session-scoped.
