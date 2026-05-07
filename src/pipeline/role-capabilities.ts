/**
 * Default per-role `RoleCapabilities` for Phase 2c-ii.4.
 *
 * Operationalizes the §17.1 defaults from the agentic-pipeline spec into
 * concrete shell-pattern strings, file-write globs, and network scopes that
 * the Rust `pipeline_capabilities_install` IPC translates into Claude Code
 * `permissions.allow` / `permissions.deny` entries.
 *
 * The spec table at §17.1 is a high-level sketch ("read-only verbs", "project
 * tree minus .git", etc.). The strings here are this implementation's
 * interpretation; they live in one place so future tasks (Phase 2c-iii's
 * per-template overrides, Phase 3's sub-agent inheritance) can read them as
 * the canonical baseline.
 *
 * Per the §17.1 wording:
 *   - Reviewer is **physically incapable of writing** — `fileWrites.deny`
 *     covers `**` so neither Write() nor Edit() can match an allow entry.
 *   - Planner has narrowest fileWrites scope (specs/plans only), no shell
 *     write/destructive verbs, no network.
 *   - Builder gets the broadest scope short of the Reviewer (project tree
 *     minus secrets/.git), test-runner shell verbs, package-manager registry
 *     network egress only.
 *
 * Sentinel strings (`<<<TX_STAGE_DONE>>>` etc.) and the agent's commit verbs
 * are NOT part of this manifest — those are enforced by the role prompt and
 * the guardrails hook (`tx-pipeline-stage-handoff` skill / git-guardrails).
 */

import type { PipelineRole, RoleCapabilities } from '@/types';

/** Globs that should NEVER be written by any role. Combined with each role's deny list. */
const UNIVERSAL_DENY_GLOBS = ['**/*.env', '**/.git/**', '**/secrets.*'];

/** Read-only shell verbs — every role gets these in `allowPatterns`. */
const READ_ONLY_SHELL = [
  'rg *',
  'grep *',
  'cat *',
  'ls *',
  'find *',
  'git status',
  'git log *',
  'git diff *',
  'git show *',
];

/**
 * Destructive shell verbs every role denies. These are independent of the
 * git-guardrails hook (which also blocks them at the PreToolUse layer); the
 * settings.json deny here gives belt-and-braces.
 */
const DESTRUCTIVE_SHELL_DENY = [
  'git push *',
  'git reset --hard *',
  'rm -rf *',
  'curl *',
  'wget *',
];

/** Build/test commands the Builder may invoke. */
const BUILDER_BUILD_SHELL = [
  'npm *',
  'pnpm *',
  'yarn *',
  'cargo *',
  'pytest *',
  'go *',
  'tsc *',
  'vitest *',
];

const COMMON_MAX_FILE_SIZE = 256_000;

/**
 * Returns the spec-§17.1 default `RoleCapabilities` for a given role.
 *
 * Note on `controller`: the controller has no agent process and does not
 * spawn into the worktree, so it has no settings-level scoping. Callers
 * should never invoke this for `controller`; we throw to surface the bug
 * loudly rather than silently install nothing.
 */
export function defaultRoleCapabilities(role: PipelineRole): RoleCapabilities {
  switch (role) {
    case 'planner':
      return {
        fileWrites: {
          allow: ['docs/superpowers/specs/**', 'docs/superpowers/plans/**'],
          deny: [...UNIVERSAL_DENY_GLOBS],
        },
        shell: {
          allowPatterns: [...READ_ONLY_SHELL],
          denyPatterns: [...DESTRUCTIVE_SHELL_DENY],
        },
        network: 'none',
        mcpTools: [],
        maxFileSize: COMMON_MAX_FILE_SIZE,
      };

    case 'builder':
      // Spec §17.1: "project tree minus secrets/.git/node_modules/build dirs."
      // Allow `**` and rely on the deny list — narrower allow would block real
      // edits (package.json, Cargo.toml, config files at repo root, READMEs)
      // and the first dep-bump would fail with a permission denial.
      return {
        fileWrites: {
          allow: ['**'],
          deny: [
            ...UNIVERSAL_DENY_GLOBS,
            '**/node_modules/**',
            '**/target/**',
            '**/dist/**',
            '**/.tx-worktrees/**',
            '**/.terminalx/**',
          ],
        },
        shell: {
          allowPatterns: [...READ_ONLY_SHELL, ...BUILDER_BUILD_SHELL],
          denyPatterns: [...DESTRUCTIVE_SHELL_DENY],
        },
        network: 'package-managers',
        mcpTools: [],
        maxFileSize: COMMON_MAX_FILE_SIZE,
      };

    case 'reviewer':
    case 'reviewer-codex':
      return {
        // Read-only: empty allow + deny ** means no write or edit can match.
        fileWrites: {
          allow: [],
          deny: ['**'],
        },
        shell: {
          allowPatterns: [...READ_ONLY_SHELL],
          denyPatterns: [...DESTRUCTIVE_SHELL_DENY],
        },
        network: 'none',
        mcpTools: [],
        maxFileSize: COMMON_MAX_FILE_SIZE,
      };

    case 'controller':
      throw new Error('controller has no RoleCapabilities — it is not an agent process');
  }
}
