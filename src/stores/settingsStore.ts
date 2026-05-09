import { create } from 'zustand';

/**
 * Settings panel categories. Sub-panels are added in subsequent Phase-3a tasks
 * (3a.2 / 3a.4 / 3a.5); for now the body is a placeholder that surfaces the
 * active category to the user.
 */
export const SETTINGS_CATEGORIES = ['project', 'agents', 'pipeline', 'plugins', 'about'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

const ACTIVE_CATEGORY_KEY = 'tx-settings-active-category';
const DEFAULT_CATEGORY: SettingsCategory = 'project';

function isValidCategory(value: string | null): value is SettingsCategory {
  return value !== null && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

function loadCategory(): SettingsCategory {
  try {
    const raw = localStorage.getItem(ACTIVE_CATEGORY_KEY);
    if (isValidCategory(raw)) return raw;
  } catch {
    // localStorage may be unavailable (e.g. SSR/test).
  }
  return DEFAULT_CATEGORY;
}

function persistCategory(category: SettingsCategory): void {
  try {
    localStorage.setItem(ACTIVE_CATEGORY_KEY, category);
  } catch {
    // Best-effort. Quota / privacy modes shouldn't crash the app.
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline preferences (Phase 3a.7)                                   */
/* ------------------------------------------------------------------ */

export const PIPELINE_TEMPLATE_IDS = [
  'tx.pipeline.anthropic-trio',
  'tx.pipeline.hello-world',
] as const;
export type PipelineDefaultTemplateId = (typeof PIPELINE_TEMPLATE_IDS)[number];

export interface PipelinePrefs {
  /** Which template the launch modal pre-selects. */
  defaultTemplate: PipelineDefaultTemplateId;
  /** Branch-name template. Tokens: `{date}` (YYYY-MM-DD), `{shortId}` (4-char). */
  branchPattern: string;
  /** When true, trivial-complexity plans skip the human-approve gate. */
  autoApproveTrivial: boolean;
  /**
   * Auto-delete terminal-state runs (`done`/`failed`/`escalated`) plus their
   * telemetry JSONL + orphaned worktrees once they age past this many days.
   * Triggered once at app boot per active project; the Rust side
   * (`pipeline_cleanup_old_runs`) is the actual deleter. `0` means never run.
   */
  retentionDays: number;
}

const PIPELINE_PREFS_KEY = 'tx-pipeline-prefs';
export const DEFAULT_PIPELINE_PREFS: PipelinePrefs = {
  defaultTemplate: 'tx.pipeline.anthropic-trio',
  branchPattern: 'pipeline/run-{date}-{shortId}',
  autoApproveTrivial: false,
  retentionDays: 30,
};

/** Clamp to a sane range so a typo can't accidentally wipe everything (0 = never). */
export const MAX_RETENTION_DAYS = 3650; // ~10y

function isValidTemplateId(id: unknown): id is PipelineDefaultTemplateId {
  return typeof id === 'string' && (PIPELINE_TEMPLATE_IDS as readonly string[]).includes(id);
}

function loadPipelinePrefs(): PipelinePrefs {
  try {
    const raw = localStorage.getItem(PIPELINE_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PIPELINE_PREFS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PIPELINE_PREFS };
    return {
      defaultTemplate: isValidTemplateId(parsed.defaultTemplate)
        ? parsed.defaultTemplate
        : DEFAULT_PIPELINE_PREFS.defaultTemplate,
      branchPattern:
        typeof parsed.branchPattern === 'string' && parsed.branchPattern.length > 0
          ? parsed.branchPattern
          : DEFAULT_PIPELINE_PREFS.branchPattern,
      autoApproveTrivial:
        typeof parsed.autoApproveTrivial === 'boolean'
          ? parsed.autoApproveTrivial
          : DEFAULT_PIPELINE_PREFS.autoApproveTrivial,
      retentionDays: clampRetention(parsed.retentionDays),
    };
  } catch {
    return { ...DEFAULT_PIPELINE_PREFS };
  }
}

/**
 * Clamp `retentionDays` to a sane integer in `[0, MAX_RETENTION_DAYS]`. `0`
 * is the legitimate "never run" sentinel; negative or non-finite values fall
 * back to the default (30) so a corrupted prefs blob doesn't accidentally
 * disable cleanup forever.
 */
export function clampRetention(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PIPELINE_PREFS.retentionDays;
  }
  const n = Math.floor(value);
  if (n < 0) return DEFAULT_PIPELINE_PREFS.retentionDays;
  if (n > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return n;
}

function persistPipelinePrefs(prefs: PipelinePrefs): void {
  try {
    localStorage.setItem(PIPELINE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort.
  }
}

/**
 * Branch-name regex shared with the Rust `validate_branch_name` (kept in
 * lockstep). Surfaced here so the UI can validate-token expansion locally
 * before the launch flow round-trips through the IPC.
 */
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Pure helper — expand `{date}` / `{shortId}` and return the candidate plus
 * a validation flag. `shortIdSource` lets tests inject deterministic ids;
 * production passes the runtime-generated random id from `App.tsx`.
 */
export function expandBranchPattern(
  pattern: string,
  opts: { now?: Date; shortIdSource?: () => string } = {},
): { branch: string; valid: boolean } {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const shortId =
    opts.shortIdSource?.() ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 4)
      : Math.random().toString(36).slice(2, 6));
  const branch = pattern.replace(/\{date\}/g, date).replace(/\{shortId\}/g, shortId);
  return { branch, valid: BRANCH_NAME_RE.test(branch) };
}

interface SettingsState {
  open: boolean;
  category: SettingsCategory;
  pipelinePrefs: PipelinePrefs;
  /** Open the panel. If `category` is supplied, switch to it; otherwise reuse last-viewed. */
  openAt: (category?: SettingsCategory) => void;
  close: () => void;
  setCategory: (category: SettingsCategory) => void;
  /** Patch any subset of pipeline prefs; persists synchronously. */
  setPipelinePrefs: (patch: Partial<PipelinePrefs>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  open: false,
  category: loadCategory(),
  pipelinePrefs: loadPipelinePrefs(),
  openAt: (category) => {
    if (category) {
      persistCategory(category);
      set({ open: true, category });
    } else {
      set({ open: true });
    }
  },
  close: () => set({ open: false }),
  setCategory: (category) => {
    persistCategory(category);
    set({ category });
  },
  setPipelinePrefs: (patch) => {
    const merged = { ...get().pipelinePrefs, ...patch };
    // Re-clamp `retentionDays` on every patch so a UI input that hands us
    // `-5` or `Infinity` can't bypass the load-time validator.
    const next: PipelinePrefs = {
      ...merged,
      retentionDays: clampRetention(merged.retentionDays),
    };
    persistPipelinePrefs(next);
    set({ pipelinePrefs: next });
  },
}));
