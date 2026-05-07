/**
 * Brief assembly for one-shot agents (Reviewer / Reviewer-Codex / Tiebreaker / Red Team).
 *
 * The dispatchers were stubbed in their respective phases (3c.4, 3c.6,
 * Polish.1) with a placeholder hand-rolled brief. The audit caught that
 * complex/dual runs would reliably abort because the agent received empty
 * or near-empty stdin. This module assembles a real brief by:
 *
 *   1. Reading the bundled role prompt (`pipelineReadRolePrompt(role)`).
 *   2. Substituting the project's INVARIANTS.md content (mirrors the
 *      role-prompt-injection.ts substitution pattern).
 *   3. Appending live run context — branch, base branch, worktree, latest
 *      build artifact, plan + spec paths.
 *
 * Phase 3d will likely flesh this out with a real diff (`git diff main..HEAD`
 * stitched into the brief) and INVARIANTS-as-blocker reminders. The current
 * shape is enough that the agent can self-locate and emit the expected
 * sentinel rather than failing on empty input.
 */

import type { PipelineRole, PipelineRun } from '@/types';
import { pipelineReadRolePrompt, readFileText } from '@/utils/ipc';

const INVARIANTS_PLACEHOLDER = '{INVARIANTS_PLACEHOLDER}';

async function readInvariants(projectDir: string | undefined): Promise<string | null> {
  if (!projectDir) return null;
  try {
    const text = await readFileText(`${projectDir}/INVARIANTS.md`);
    return text.trim().length > 0 ? text : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such file|not found|enoent/i.test(msg)) {
      console.warn(`[brief-builder] INVARIANTS read failed for ${projectDir}:`, msg);
    }
    return null;
  }
}

function substituteInvariants(prompt: string, content: string | null): string {
  const replacement = content && content.trim().length > 0
    ? content
    : '(none specified — proceed with role defaults)';
  return prompt.split(INVARIANTS_PLACEHOLDER).join(replacement);
}

function summarizeRun(run: PipelineRun): string {
  const lastBuild = run.artifacts.builds[run.artifacts.builds.length - 1];
  const lines: string[] = [
    '## Run context',
    `- runId: ${run.id}`,
    `- branch: ${run.branch}`,
    `- baseBranch: ${run.baseBranch}`,
    `- worktree: ${run.worktreePath}`,
    `- complexity: ${run.runMode}`,
  ];
  if (run.artifacts.plan) {
    lines.push(`- specPath: ${run.artifacts.plan.specPath}`);
    lines.push(`- planPath: ${run.artifacts.plan.planPath}`);
    lines.push(`- planTasks: ${run.artifacts.plan.tasks.length}`);
  }
  if (lastBuild) {
    lines.push(`- builderRound: ${lastBuild.round}`);
    lines.push(`- headSha: ${lastBuild.headSha}`);
    lines.push(`- filesChanged: ${lastBuild.filesChanged.length}`);
    lines.push(`- commits: ${lastBuild.commits.length}`);
    lines.push(`- ciStatus: ${lastBuild.ciStatus}`);
  }
  if (run.artifacts.reviews.length > 0) {
    const lastReview = run.artifacts.reviews[run.artifacts.reviews.length - 1];
    lines.push(`- priorReviewerVerdict: ${lastReview.verdict} (${lastReview.reviewer})`);
  }
  return lines.join('\n');
}

export interface BriefDeps {
  /** Inject for tests; production wires `pipelineReadRolePrompt`. */
  readRolePrompt?: (role: PipelineRole) => Promise<string | null>;
  /** Inject for tests; production wires `readFileText` for INVARIANTS. */
  readInvariants?: (projectDir: string | undefined) => Promise<string | null>;
}

/**
 * Build a one-shot agent brief: role prompt + INVARIANTS substitution +
 * run-state summary. Returns the assembled string (the agent's stdin).
 *
 * Returns an empty string only if the role prompt itself is missing or
 * empty — which is a deployment bug. The dispatcher should treat empty
 * return as "do not fire."
 */
export async function buildOneshotBrief(opts: {
  role: PipelineRole;
  run: PipelineRun;
  projectDir: string | undefined;
  deps?: BriefDeps;
}): Promise<string> {
  const deps = opts.deps ?? {};
  const readPrompt = deps.readRolePrompt ?? pipelineReadRolePrompt;
  const readInv = deps.readInvariants ?? readInvariants;

  const [prompt, invariants] = await Promise.all([
    readPrompt(opts.role).catch(() => null),
    readInv(opts.projectDir),
  ]);

  if (!prompt || prompt.trim().length === 0) {
    return '';
  }

  const promptWithInvariants = substituteInvariants(prompt, invariants);
  const runSummary = summarizeRun(opts.run);
  return `${promptWithInvariants}\n\n${runSummary}\n`;
}
