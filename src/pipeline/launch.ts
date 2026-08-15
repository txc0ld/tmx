/**
 * Pipeline run launch flow (Phase 4 entry point).
 *
 * The path from "user clicks Start" to "tiles + worktree + run exist on the
 * canvas". Composes everything that previously had no UI caller:
 *
 *   1. Resolve active project → projectDir.
 *   2. Validate goal + branch.
 *   3. Preflight (`pipeline_preflight` IPC) — captures baseBranch + sensitive
 *      paths + git/CLI health up front.
 *   4. SensitivePathsModal gate — promise-resolver wired by the App layer.
 *      User cancel = abort, no worktree created, no run state inserted.
 *   5. Worktree create (`pipeline_worktree_create`).
 *   6. `createRunFromTemplate(anthropicTrioTemplate(), …)` — fingerprint +
 *      store insertion. We've already cleared the sensitive-paths gate, so
 *      we do NOT pass `preflight` / `confirmSensitivePaths` to the factory
 *      (would double-call the IPC).
 *   7. Write `<worktreePath>/PIPELINE_GOAL.md` so the planner agent has the
 *      user-stated goal as a tracked file.
 *   8. `instantiatePipelineTemplate` → tile + wire arrays → canvasStore.
 *      Each AgentTile's `cwd` is overridden to the worktree path so the
 *      agent process spawns in the run's isolated branch.
 *
 * Failure modes destroy the worktree if it was created — the factory itself
 * never owns worktree lifecycle, that's this layer's job.
 */

import { homeDir } from '@tauri-apps/api/path';
import {
  pipelineCapabilitiesInstall,
  pipelineGuardrailsInstall,
  pipelinePreflight,
  pipelineWorktreeCreate,
  pipelineWorktreeDestroy,
  writeFileText,
  type PreflightResult,
} from '@/utils/ipc';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { screenToCanvas } from '@/utils/layout';
import { joinPath } from '@/utils/path';
import { createRunFromTemplate, defaultRunFactoryDeps } from './run-factory';
import { instantiatePipelineTemplate } from './instantiate';
import { anthropicTrioTemplate, helloWorldTemplate } from './templates';
import { defaultRoleCapabilities } from './role-capabilities';
import { persistRun, defaultRunPersistenceDeps } from './run-persistence';
import { usePipelineStore } from '@/stores/pipelineStore';
import { isTerminalState } from './state-machine';
import type { Tile, AgentTile, PipelineRun } from '@/types';

const TX_VERSION = '0.2.0';

/** Same regex as `validate_branch_name` on the Rust side, kept in sync to
 *  fail fast in the UI before round-tripping through the IPC. */
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function preflightBlockers(preflight: PreflightResult): string[] {
  const blockers: string[] = [];
  if (!preflight.claude_present) blockers.push('Claude CLI is not on PATH.');
  if (!preflight.capability_binaries_ok) blockers.push('Required capability binaries are missing.');
  if (!preflight.worktree_dir_writable) blockers.push('Project .tx-worktrees directory is not writable.');
  if (!preflight.skill_cache_writable) blockers.push('Agent skill cache is not writable.');
  if (!preflight.signed_skills_ok) blockers.push('Bundled pipeline skills are missing or have been modified.');
  blockers.push(...preflight.errors);
  return Array.from(new Set(blockers));
}

export interface LaunchPipelineRunInput {
  goal: string;
  branch: string;
  /**
   * Template id chosen in the launch modal. Currently one of:
   *   - `tx.pipeline.anthropic-trio` (production default)
   *   - `tx.pipeline.hello-world`    (smoke test)
   * Unknown ids fall through to Anthropic Trio (with a console.warn) so a
   * stale persisted choice can never block a launch.
   */
  templateId: string;
  /**
   * UI-side gate — invoked when preflight reports any sensitive paths.
   * Resolves true → proceed, false → abort. Wired by App.tsx to mount
   * SensitivePathsModal and resolve on its button clicks.
   */
  confirmSensitivePaths(paths: string[]): Promise<boolean>;
  /**
   * Power-user / scripted launches: bypass the concurrent-run guard.
   * Two active runs on the same project share `.claude/settings.json`,
   * so capability lifecycle handlers will fight to overwrite. Default
   * `false` (or omitted) protects the common path; callers that know
   * what they're doing can opt in. NOT exposed in UI.
   */
  force?: boolean;
}

export type LaunchPipelineRunResult =
  | { ok: true; runId: string; worktreePath: string }
  | {
      ok: false;
      error: string;
      reason:
        | 'no-project'
        | 'invalid-input'
        | 'preflight'
        | 'cancelled'
        | 'worktree'
        | 'factory'
        | 'already-active'
        | 'unknown';
    };

/** Subset of `pipelineStore` state we read for the concurrent-run guard.
 *  Lifted to an interface so tests can dep-inject a fake without touching
 *  the real Zustand store. */
export interface PipelineStoreSnapshot {
  runs: Record<string, PipelineRun>;
}

export interface LaunchPipelineRunDeps {
  /** Defaults to `usePipelineStore.getState`. */
  getStoreState?: () => PipelineStoreSnapshot;
}

/**
 * Default implementation. Pure imperative orchestration over Zustand stores
 * + Rust IPCs; no React imports so it stays headlessly testable.
 */
export async function launchPipelineRun(
  input: LaunchPipelineRunInput,
  launchDeps: LaunchPipelineRunDeps = {},
): Promise<LaunchPipelineRunResult> {
  const getStoreState = launchDeps.getStoreState ?? (() => usePipelineStore.getState());

  // 1. Active project.
  const { active, projects } = useProjectStore.getState();
  const project = projects.find((p) => p.id === active);
  if (!project) {
    return { ok: false, error: 'No active project — pick a project in the sidebar first.', reason: 'no-project' };
  }
  const projectDir = (project.cwd ?? '').trim();
  if (!projectDir) {
    return { ok: false, error: `Active project "${project.name}" has no cwd configured.`, reason: 'no-project' };
  }
  const projectId = project.id;

  // 1.5. Concurrent-run guard. Two non-terminal runs on the same project
  //      share `.claude/settings.json` — capability lifecycle handlers
  //      from each fight to overwrite, telemetry conflicts, persistence
  //      assumes one-active-run-per-project. Power users can pass
  //      `force: true` to bypass.
  if (!input.force) {
    const runs = getStoreState().runs;
    const active = Object.values(runs).find(
      (r) => r.projectId === projectId && !isTerminalState(r.state),
    );
    if (active) {
      return {
        ok: false,
        error: `Already have a pipeline run in ${active.state} on this project (run ${active.id}). Abort or finish that one first.`,
        reason: 'already-active',
      };
    }
  }

  // 2. Validate inputs.
  const goal = input.goal.trim();
  const branch = input.branch.trim();
  if (!goal) return { ok: false, error: 'Goal is required.', reason: 'invalid-input' };
  if (!branch) return { ok: false, error: 'Branch name is required.', reason: 'invalid-input' };
  if (!BRANCH_RE.test(branch)) {
    return {
      ok: false,
      error: 'Branch name may only contain letters, digits, dots, underscores, slashes, hyphens.',
      reason: 'invalid-input',
    };
  }

  // 3. Preflight up front. Captures baseBranch + sensitive paths + tooling
  //    health in one IPC call so we don't pay the cost twice.
  let preflight: PreflightResult;
  try {
    preflight = await pipelinePreflight(projectDir);
  } catch (e) {
    return { ok: false, error: `Preflight failed: ${stringifyErr(e)}`, reason: 'preflight' };
  }

  if (!preflight.is_git_repo) {
    return {
      ok: false,
      error: 'Project directory is not a git repository. Run `git init` and an initial commit there first.',
      reason: 'preflight',
    };
  }
  const blockers = preflightBlockers(preflight);
  if (blockers.length > 0) {
    return {
      ok: false,
      error: `Pipeline preflight blocked launch:\n- ${blockers.join('\n- ')}`,
      reason: 'preflight',
    };
  }
  const baseBranch = preflight.main_branch ?? 'main';

  // 4. Sensitive-paths gate. Run ONCE here; the factory's gate is bypassed
  //    so we don't IPC twice for the same data.
  if (preflight.sensitive_paths_found.length > 0) {
    const ok = await input.confirmSensitivePaths(preflight.sensitive_paths_found);
    if (!ok) {
      return { ok: false, error: 'Cancelled at sensitive-paths gate.', reason: 'cancelled' };
    }
  }

  // 5. Generate identifiers.
  const runId = crypto.randomUUID();
  const worktreePath = joinPath(projectDir, '.tx-worktrees', runId);

  // 6. Create the worktree. From here on, any failure must destroy it.
  try {
    await pipelineWorktreeCreate({ projectDir, branch, worktreePath, baseBranch });
  } catch (e) {
    return { ok: false, error: `Worktree create failed: ${stringifyErr(e)}`, reason: 'worktree' };
  }

  // 6.5. Pre-install planner capabilities + guardrails into the worktree's
  //     `.claude/settings.json` BEFORE the AgentTile mounts and spawns the
  //     Claude Code process. Claude Code reads `.claude/settings.json` once
  //     at session start; if the file is missing/empty when the agent boots,
  //     no allow/deny scoping applies and every Bash invocation triggers a
  //     "Do you want to proceed?" prompt — even when our capabilities-
  //     lifecycle handler eventually writes the same content seconds later
  //     (the agent doesn't re-read mid-session).
  //
  //     The capabilities-lifecycle handler still runs on the
  //     `idle → planning` transition (when the user clicks Start); since the
  //     Rust IPC is idempotent and the marker round-trips, that becomes a
  //     no-op for the planner role. Builder/Reviewer caps still install via
  //     the lifecycle handler on their respective state transitions.
  try {
    await pipelineGuardrailsInstall(worktreePath);
  } catch (e) {
    console.warn('[pipeline] pre-spawn guardrails install failed (non-fatal):', e);
  }
  try {
    await pipelineCapabilitiesInstall({
      worktreeDir: worktreePath,
      role: 'planner',
      capabilities: defaultRoleCapabilities('planner'),
    });
  } catch (e) {
    console.warn('[pipeline] pre-spawn planner capabilities install failed (non-fatal):', e);
  }

  // 7. Drive the factory. Skill / role-prompt / capability / invariants reads
  //    flow through `defaultRunFactoryDeps`; preflight + confirmSensitivePaths
  //    intentionally stripped (we did them above — re-running them inside the
  //    factory would double-IPC).
  let home: string;
  try {
    home = await homeDir();
  } catch (e) {
    await safeDestroyWorktree({ projectDir, worktreePath, branch });
    return { ok: false, error: `Could not resolve home directory: ${stringifyErr(e)}`, reason: 'unknown' };
  }
  const baseDeps = defaultRunFactoryDeps({ projectDir, homeDir: home });
  const { preflight: _omit, ...deps } = baseDeps;
  void _omit;

  // Resolve template by id. Default to Anthropic Trio for unknown ids; we
  // never want a misbehaving persisted choice to block a launch.
  let template = anthropicTrioTemplate();
  if (input.templateId === 'tx.pipeline.hello-world') {
    template = helloWorldTemplate();
  } else if (input.templateId !== 'tx.pipeline.anthropic-trio') {
    console.warn(
      `[pipeline] unknown templateId "${input.templateId}", falling back to Anthropic Trio.`,
    );
  }

  let factoryResult;
  try {
    factoryResult = await createRunFromTemplate({
      runId,
      template,
      projectId,
      worktreePath,
      branch,
      baseBranch,
      projectDir,
      terminalxVersion: TX_VERSION,
      // Phase 3a.7: seed from user pref. The reducer still authoritatively
      // re-stamps on planner_done based on plan complexity, so this is
      // primarily an audit-trail / future-consumer signal.
      autoApprovePlan: useSettingsStore.getState().pipelinePrefs.autoApproveTrivial,
      deps,
    });
  } catch (e) {
    await safeDestroyWorktree({ projectDir, worktreePath, branch });
    return { ok: false, error: `Run creation failed: ${stringifyErr(e)}`, reason: 'factory' };
  }

  if (factoryResult.aborted) {
    // Belt-and-braces: factory shouldn't abort because we didn't wire the
    // gate at that layer, but if a future caller adds it back, behave correctly.
    await safeDestroyWorktree({ projectDir, worktreePath, branch });
    return { ok: false, error: 'Cancelled by factory gate.', reason: 'cancelled' };
  }

  // 7.5. One-shot persist: the lifecycle handler only fires on STATE
  //      transitions, but a freshly-created run sitting in `idle` has had
  //      no transition yet. Without this write, a reload between create-
  //      and-start would lose the run record entirely.
  const newRun = usePipelineStore.getState().runs[factoryResult.runId];
  if (newRun) {
    await persistRun(newRun, defaultRunPersistenceDeps());
  }

  // 8. Persist the goal so the planner can read it as a file. Non-fatal —
  //    a failure here doesn't tear down the run; the user can always paste
  //    the goal into the planner's terminal manually.
  try {
    await writeFileText(joinPath(worktreePath, 'PIPELINE_GOAL.md'), `# Pipeline goal\n\n${goal}\n`);
  } catch (e) {
    console.warn('[pipeline] PIPELINE_GOAL.md write failed (non-fatal):', e);
  }

  // 9. Instantiate the template into tiles + wires and place them near the
  //    canvas viewport's top-left. (Anchor at screen 40,60 → canvas coords.)
  const transform = useCanvasStore.getState().transforms[projectId] ?? { x: 0, y: 0, scale: 1 };
  const origin = screenToCanvas(40, 60, transform);
  const { tiles, wires } = instantiatePipelineTemplate(template, {
    runId,
    originX: origin.x,
    originY: origin.y,
  });

  // 10. Override agent tiles' cwd → worktree, so the spawned PTY runs in the
  //     isolated branch. Template config can't carry this since it's per-run.
  const placedTiles: Tile[] = tiles.map((t) =>
    t.type === 'agent'
      ? ({ ...(t as AgentTile), cwd: worktreePath, branch })
      : t,
  );

  const canvas = useCanvasStore.getState();
  for (const t of placedTiles) canvas.addTile(t);
  for (const w of wires) canvas.addWire(w);

  // Auto-fit: zoom + pan so the three agent tiles + controller fit the
  // viewport. The pipeline template's 3-wide layout overflows most
  // laptop screens at 100%, so we land at whatever scale fits with a
  // 60px margin on each side. Capped at 1.0 so we never zoom IN past
  // native pixels (which would just blur the text).
  if (placedTiles.length > 0) {
    const minX = Math.min(...placedTiles.map((t) => t.x));
    const minY = Math.min(...placedTiles.map((t) => t.y));
    const maxX = Math.max(...placedTiles.map((t) => t.x + t.w));
    const maxY = Math.max(...placedTiles.map((t) => t.y + t.h));
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const margin = 60;
    const scaleX = (window.innerWidth - margin * 2) / bboxW;
    const scaleY = (window.innerHeight - margin * 2) / bboxH;
    const scale = Math.min(1, scaleX, scaleY);
    // Center the bbox in the viewport, then translate to canvas origin.
    const tx = (window.innerWidth - bboxW * scale) / 2 - minX * scale;
    const ty = (window.innerHeight - bboxH * scale) / 2 - minY * scale;
    canvas.setTransform({ x: tx, y: ty, scale });
  }

  return { ok: true, runId, worktreePath };
}

async function safeDestroyWorktree(opts: { projectDir: string; worktreePath: string; branch: string }) {
  try {
    await pipelineWorktreeDestroy(opts);
  } catch (e) {
    console.warn('[pipeline] worktree destroy failed during error rollback (continuing):', e);
  }
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
