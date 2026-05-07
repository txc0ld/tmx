/**
 * Inject the role prompt for a freshly-spawned pipeline agent into its PTY.
 *
 * The bundled prompt files live in `src-tauri/resources/role-prompts/<role>.md`
 * (Phase 2c-iii). We only inject when the AgentTile's `mode` matches one of
 * the four real pipeline roles — the `-stub` variants used by the smoke
 * template are skipped.
 *
 * Phase 3b.7: at spawn time we also read `<projectDir>/INVARIANTS.md` and
 * substitute its content into the `{INVARIANTS_PLACEHOLDER}` token in the
 * role prompt. This is re-read per-spawn (not cached on the run) so a user
 * editing `INVARIANTS.md` mid-run gets the new content on the next role
 * spawn. The factory still hashes the same file at run-creation for the
 * fingerprint (Phase 2c-i).
 */

import { pipelineReadRolePrompt, ptyWrite, onPtyOutput, readFileText } from '@/utils/ipc';

type Role = 'planner' | 'builder' | 'reviewer' | 'reviewer-codex';

const ROLE_MODES: ReadonlySet<Role> = new Set([
  'planner',
  'builder',
  'reviewer',
  'reviewer-codex',
]);

const PLACEHOLDER = '{INVARIANTS_PLACEHOLDER}';
const INVARIANTS_FALLBACK = '(none specified — proceed with role defaults)';

export function isPipelineRoleMode(mode: string | undefined): mode is Role {
  return mode !== undefined && ROLE_MODES.has(mode as Role);
}

/**
 * Replace every `{INVARIANTS_PLACEHOLDER}` occurrence in `prompt` with either
 * the file content (when non-empty) or a "(none specified)" fallback. Old
 * prompts that don't contain the placeholder pass through unchanged.
 *
 * Exported for unit-testing the substitution logic in isolation from the
 * PTY-write timing machinery.
 */
export function substituteInvariants(
  prompt: string,
  invariants: string | null | undefined,
): string {
  if (!prompt.includes(PLACEHOLDER)) return prompt;
  const replacement =
    invariants && invariants.trim().length > 0 ? invariants : INVARIANTS_FALLBACK;
  // Use split/join rather than a regex so we don't have to escape the braces
  // and we replace ALL occurrences (defensive: a future prompt revision may
  // reference the placeholder twice).
  return prompt.split(PLACEHOLDER).join(replacement);
}

/**
 * Best-effort read of `<projectDir>/INVARIANTS.md`. ENOENT-shaped errors
 * (missing optional file) return `null` silently; any other error logs a
 * `console.warn` and also returns `null` so injection still proceeds with
 * the fallback string. Mirrors `defaultRunFactoryDeps.readInvariants` for
 * consistency with the fingerprint read at run-creation.
 */
async function defaultReadInvariants(projectDir: string): Promise<string | null> {
  if (!projectDir) return null;
  const trimmed = projectDir.replace(/[\\/]+$/, '');
  try {
    const text = await readFileText(`${trimmed}/INVARIANTS.md`);
    return text.length > 0 ? text : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such file|not found|enoent/i.test(msg)) {
      console.warn(`[role-prompt] read INVARIANTS.md for ${trimmed} failed:`, msg);
    }
    return null;
  }
}

/**
 * Strip ANSI escapes + control chars before writing to a PTY — same hardening
 * the agent-memory injection applies. Pasting unescaped content into a live
 * terminal can manipulate the cursor / clipboard / window title.
 */
function sanitizeForPty(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * After agent spawn, wait for ~1.2s of PTY silence (agent past its startup
 * banner), then write the role prompt + a CR. Hard ceiling 15s. Returns a
 * promise that resolves when the prompt has been written (or skipped).
 *
 * No-ops if `mode` isn't a real pipeline role, or if the bundled prompt
 * file is missing/empty (treated as "not yet authored").
 *
 * `projectDir` (optional) is used to read `<projectDir>/INVARIANTS.md` for
 * placeholder substitution. When omitted, the placeholder is replaced with
 * the "(none specified)" fallback. The caller (AgentTile) passes the
 * worktree path; tests can omit it or override via `deps.readInvariants`.
 */
export async function injectRolePromptForAgent(opts: {
  ptyId: string;
  mode: string | undefined;
  /** Project / worktree dir used to read INVARIANTS.md at spawn time. */
  projectDir?: string;
  /** Test-only: inject mock IPCs. Production passes the real ones. */
  deps?: {
    readRolePrompt: typeof pipelineReadRolePrompt;
    write: typeof ptyWrite;
    listen: typeof onPtyOutput;
    /** Test-only: override the INVARIANTS.md read. Default reads via IPC. */
    readInvariants?: (projectDir: string) => Promise<string | null>;
  };
}): Promise<{ injected: boolean; reason?: string }> {
  const { ptyId, mode, projectDir } = opts;
  const deps = opts.deps ?? {
    readRolePrompt: pipelineReadRolePrompt,
    write: ptyWrite,
    listen: onPtyOutput,
  };
  const readInvariants = deps.readInvariants ?? defaultReadInvariants;

  if (!isPipelineRoleMode(mode)) {
    return { injected: false, reason: 'mode not a pipeline role' };
  }

  let prompt: string | null;
  try {
    prompt = await deps.readRolePrompt(mode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[role-prompt] read failed for ${mode}:`, msg);
    return { injected: false, reason: `read failed: ${msg}` };
  }

  if (!prompt || prompt.length === 0) {
    return { injected: false, reason: 'prompt absent or empty' };
  }

  // Phase 3b.7: substitute INVARIANTS.md content if the prompt references it.
  // We only invoke the file read when the prompt actually contains the
  // placeholder — old prompts that pre-date Phase 3b.7 avoid an unnecessary
  // IPC round-trip.
  if (prompt.includes(PLACEHOLDER)) {
    const invariants = projectDir ? await readInvariants(projectDir) : null;
    prompt = substituteInvariants(prompt, invariants);
  }

  const safe = sanitizeForPty(prompt);

  return new Promise((resolve) => {
    let injected = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanup: (() => void) | null = null;

    const fire = () => {
      if (injected) return;
      injected = true;
      if (silenceTimer !== null) clearTimeout(silenceTimer);
      clearTimeout(fallbackTimer);
      cleanup?.();
      deps.write(ptyId, safe).catch(() => {
        /* PTY exited or invalid — not fatal */
      });
      setTimeout(() => {
        deps.write(ptyId, '\r').catch(() => {
          /* same — best-effort */
        });
        resolve({ injected: true });
      }, 300);
    };

    const fallbackTimer = setTimeout(() => fire(), 15_000);

    deps
      .listen(({ id }) => {
        if (id !== ptyId || injected) return;
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => fire(), 1200);
      })
      .then((unlisten) => {
        if (injected) {
          unlisten();
          return;
        }
        cleanup = unlisten;
      })
      .catch(() => {
        /* listener registration failed — fall back to the 15s ceiling */
      });
  });
}
