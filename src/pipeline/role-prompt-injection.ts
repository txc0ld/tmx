/**
 * Inject the role prompt for a freshly-spawned pipeline agent into its PTY.
 *
 * The bundled prompt files live in `src-tauri/resources/role-prompts/<role>.md`
 * (Phase 2c-iii). We only inject when the AgentTile's `mode` matches one of
 * the four real pipeline roles — the `-stub` variants used by the smoke
 * template are skipped.
 */

import { pipelineReadRolePrompt, ptyWrite, onPtyOutput } from '@/utils/ipc';

type Role = 'planner' | 'builder' | 'reviewer' | 'reviewer-codex';

const ROLE_MODES: ReadonlySet<Role> = new Set([
  'planner',
  'builder',
  'reviewer',
  'reviewer-codex',
]);

export function isPipelineRoleMode(mode: string | undefined): mode is Role {
  return mode !== undefined && ROLE_MODES.has(mode as Role);
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
 */
export async function injectRolePromptForAgent(opts: {
  ptyId: string;
  mode: string | undefined;
  /** Test-only: inject mock IPCs. Production passes the real ones. */
  deps?: {
    readRolePrompt: typeof pipelineReadRolePrompt;
    write: typeof ptyWrite;
    listen: typeof onPtyOutput;
  };
}): Promise<{ injected: boolean; reason?: string }> {
  const { ptyId, mode } = opts;
  const deps = opts.deps ?? {
    readRolePrompt: pipelineReadRolePrompt,
    write: ptyWrite,
    listen: onPtyOutput,
  };

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
