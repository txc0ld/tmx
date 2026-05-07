/**
 * Production entry point for creating a pipeline run from a template.
 *
 * Phase 2c-i.6: this is the wiring layer that the future spawn UI
 * (Phase 2c-iii / Phase 3) will call. It bundles:
 *   1. SKILL.md content reads (one per unique skill in the template's
 *      `pipeline.skillBindings`)
 *   2. Per-role prompt + capability lookups (no-op until Phase 2c-iii
 *      authors them)
 *   3. Optional INVARIANTS.md read from the project root
 *   4. computeFullFingerprint() over those inputs
 *   5. usePipelineStore.getState().createRun(...)
 *
 * The pure functional core (`createRunFromTemplate`) takes a
 * `RunFactoryDeps` adapter so tests can drive it without touching
 * disk. `defaultRunFactoryDeps` wraps the existing `readFileText` IPC
 * for production callers.
 */

import type { PipelineTemplate } from '@/stores/templateStore';
import type { PipelineRole, RoleCapabilities, RunFingerprint } from '@/types';
import { computeFullFingerprint } from './fingerprint';
import { usePipelineStore } from '@/stores/pipelineStore';
import { readFileText, pipelineReadRolePrompt } from '@/utils/ipc';

export interface RunFactoryDeps {
  /** Reads a SKILL.md content for the given skill name. Returns null if missing. */
  readSkillContent(skillName: string): Promise<string | null>;
  /** Reads the resolved prompt text the agent will receive for the role. Returns null if not yet authored. */
  readRolePrompt(role: PipelineRole): Promise<string | null>;
  /** Returns the resolved RoleCapabilities for the role. Returns null if no per-role capability shipped. */
  readRoleCapabilities(role: PipelineRole): Promise<RoleCapabilities | null>;
  /** Reads project-root INVARIANTS.md if present. Returns null if missing/empty. */
  readInvariants(): Promise<string | null>;
}

export interface CreateRunFromTemplateInput {
  runId: string;
  template: PipelineTemplate;
  projectId: string;
  worktreePath: string;
  branch: string;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
  deps: RunFactoryDeps;
}

export interface CreateRunFromTemplateResult {
  runId: string;
  fingerprint: RunFingerprint;
}

/** Roles that can have prompts/capabilities. Excludes `controller` (no agent, no prompt). */
const PROMPTED_ROLES: readonly PipelineRole[] = [
  'planner',
  'builder',
  'reviewer',
  'reviewer-codex',
];

/**
 * Walk a template's `skillBindings` and collect the unique skill names
 * across every role. Order is irrelevant — `computeFullFingerprint`
 * sorts keys before hashing.
 */
function collectUniqueSkillNames(template: PipelineTemplate): string[] {
  const names = new Set<string>();
  for (const list of Object.values(template.pipeline.skillBindings)) {
    if (!list) continue;
    for (const name of list) names.add(name);
  }
  return Array.from(names);
}

/** Roles actually present in the template's skillBindings, intersected with PROMPTED_ROLES. */
function rolesNeedingPrompts(template: PipelineTemplate): PipelineRole[] {
  return PROMPTED_ROLES.filter((r) => template.pipeline.skillBindings[r] !== undefined);
}

export async function createRunFromTemplate(
  input: CreateRunFromTemplateInput,
): Promise<CreateRunFromTemplateResult> {
  const { template, deps } = input;

  // 1. Skills — dedup across roles, single read per unique name.
  const skillContents: Record<string, string> = {};
  const uniqueSkills = collectUniqueSkillNames(template);
  await Promise.all(
    uniqueSkills.map(async (name) => {
      const content = await deps.readSkillContent(name);
      if (typeof content === 'string') {
        skillContents[name] = content;
      }
    }),
  );

  // 2. Role prompts + capabilities — only for roles in this template.
  const rolePrompts: Partial<Record<PipelineRole, string>> = {};
  const roleCapabilities: Partial<Record<PipelineRole, RoleCapabilities>> = {};
  const roles = rolesNeedingPrompts(template);
  await Promise.all(
    roles.map(async (role) => {
      const [prompt, caps] = await Promise.all([
        deps.readRolePrompt(role),
        deps.readRoleCapabilities(role),
      ]);
      if (typeof prompt === 'string') rolePrompts[role] = prompt;
      if (caps) roleCapabilities[role] = caps;
    }),
  );

  // 3. INVARIANTS.md (optional, project root).
  const invariantsContent = await deps.readInvariants();

  // 4. Compute fingerprint.
  const fingerprint = await computeFullFingerprint({
    templateId: template.id,
    template,
    terminalxVersion: input.terminalxVersion,
    claudeVersion: input.claudeVersion,
    codexVersion: input.codexVersion,
    skillContents,
    rolePrompts,
    roleCapabilities,
    invariantsContent,
  });

  // 5. Hand off to the store.
  const runId = usePipelineStore.getState().createRun({
    runId: input.runId,
    templateId: template.id,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    fingerprint,
  });

  return { runId, fingerprint };
}

/**
 * Default Tauri-backed RunFactoryDeps that the future UI will pass in.
 *
 * - `readSkillContent` reads `<homeDir>/.claude/skills/<name>/SKILL.md`.
 *   Skill names containing `:` (e.g. `superpowers:brainstorming`) are
 *   normalized to the on-disk layout `superpowers/brainstorming` because
 *   the skill installer drops them at that path.
 * - `readInvariants` reads `<projectDir>/INVARIANTS.md`.
 * - `readRolePrompt` and `readRoleCapabilities` return `null` in this
 *   phase. Phase 2c-iii will populate them; only this function needs to
 *   change at that point — `createRunFromTemplate` callsites stay put.
 *
 * File-not-found / empty file → `null` (never propagate the error).
 */
export function defaultRunFactoryDeps(opts: {
  projectDir: string;
  homeDir: string;
}): RunFactoryDeps {
  const { projectDir, homeDir } = opts;

  const trimTrailingSlash = (p: string): string => p.replace(/[\\/]+$/, '');
  const home = trimTrailingSlash(homeDir);
  const proj = trimTrailingSlash(projectDir);

  const safeRead = async (path: string): Promise<string | null> => {
    try {
      const text = await readFileText(path);
      return text.length > 0 ? text : null;
    } catch (err) {
      // ENOENT-shaped errors are expected (missing optional file). Anything
      // else (permission denied, IPC validation, OS I/O) is a determinism
      // hazard — silently omitting it lets two runs with different real
      // content produce the same fingerprint. Log so the user can see it.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such file|not found|enoent/i.test(msg)) {
        console.warn(`[run-factory] read failed for ${path}:`, msg);
      }
      return null;
    }
  };

  return {
    readSkillContent: (skillName) => {
      // `superpowers:brainstorming` → `superpowers/brainstorming`
      const onDisk = skillName.replace(/:/g, '/');
      return safeRead(`${home}/.claude/skills/${onDisk}/SKILL.md`);
    },
    readRolePrompt: async (role) => {
      try {
        return await pipelineReadRolePrompt(role);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[run-factory] read role prompt for ${role} failed:`, msg);
        return null;
      }
    },
    readRoleCapabilities: async (_role) => null, // Phase 2c-iii.
    readInvariants: () => safeRead(`${proj}/INVARIANTS.md`),
  };
}
