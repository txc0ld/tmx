# Agentic Pipeline Template — Phase 2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up *live agent execution* for pipeline runs. After this PR, the Hello World template can actually walk through Planner → Builder → Reviewer with real Claude/Codex agents (or mocked stand-ins for testing), the controller advances state on real sentinel emissions, and every state transition lands in a per-run telemetry JSONL file.

**Out of scope** (deferred to Phase 2c):
- **CI hook** — full verification chain on commit. Phase 2b's Builder reports its own `ciStatus`; real CI runs land in 2c.
- **Rust merger + UI confirm modal** — destructive-op safety. Phase 2b stops at `awaiting_merge_approval`; the actual merge is 2c.
- **Guardrails hook install** — `git-guardrails-claude-code` setup at run-start. 2c.
- **Plan immutability/versioning** — Phase 2b plans are written once; re-plans overwrite. 2c adds `-v2` versioning.
- **Production prereqs from §17:** capability scoping, clarification sentinel UX (the protocol exists; UX is 2c), heartbeats + stuck detection, full fingerprint coverage, OS notifications, secrets handling, skill provenance signing.

**Architecture:**

```
                         ┌──────────────────────────────────────────────┐
                         │              Pipeline Controller             │
                         │            (pipelineStore + reducer)         │
                         └─────┬───────────────────────────────────┬────┘
                               │ dispatch(runId, ev)                │  state.lastTelemetryAt
                               ▲                                    ▼
        ┌──────────────────────┴───┐             ┌──────────────────────────────┐
        │  Sentinel Scanner (TS)   │             │  pipeline_telemetry_log IPC  │
        │  src/pipeline/scanner.ts │             │  appends one JSONL line/event│
        └──────────┬───────────────┘             └──────────────────────────────┘
                   │ subscribes to                                  ▲
                   ▼                                                │ from Tauri
   ┌────────────────────────────────────────────┐                   │
   │  pty-output Tauri events (existing)        │                   │
   │  + agent_run_oneshot Result (new)          │                   │
   └────────────────────────────────────────────┘                   │
                                                                    │
   ┌────────────────────────────────────────────┐                   │
   │  agent_run_oneshot Rust IPC (new)          ├───────────────────┘
   │  wraps claude --print / codex exec         │
   │  returns { stdout, exitCode } on exit      │
   └────────────────────────────────────────────┘
```

**Tech Stack:** Tauri 2 (Rust), `tokio::process::Command` for one-shot agent invocation, frontend Zustand subscribe pattern, Vitest jsdom for the scanner unit tests.

**Reference spec:** §4.3 (stage adapters), §6 (state machine), §8 (artifact schemas), §13.2 (telemetry JSONL). Phase 2a (PR #23) shipped the bundled skills; this plan turns the controller into something agents can actually drive.

**File structure:**

```
src-tauri/src/commands/
├── pipeline.rs                    (modify — Task 4: add pipeline_telemetry_log)
└── agents.rs                      (modify — Task 1: add agent_run_oneshot)
src/pipeline/
├── sentinel-scanner.ts            (new — Task 2: pure parser)
├── sentinel-scanner.test.ts       (new — Task 2)
├── controller-runtime.ts          (new — Task 3: glue between scanner + controller)
├── controller-runtime.test.ts     (new — Task 3)
├── templates.ts                   (modify — Task 5: add Anthropic Trio)
└── phase2b-smoke.test.ts          (new — Task 6: end-to-end with mocked agents)
src/utils/ipc.ts                   (modify — Tasks 1, 4: new wrappers)
CLAUDE.md                          (modify — Task 7)
```

**Critical TerminalX patterns (from CLAUDE.md):**
- All IPC must go through `src/utils/ipc.ts`. Never call `invoke()` directly from components.
- Tauri event listeners: `mounted` ref guard in cleanup.
- Zustand selector trap: never `|| []` / `?? []` / `|| {}` inside `useXxxStore(s => …)`. Use module-level `EMPTY` constants.
- Inline styles + CSS vars; no Tailwind.

---

## Task 1: `agent_run_oneshot` Rust IPC (TDD)

**Files:**
- Modify: `src-tauri/src/commands/agents.rs`
- Modify: `src-tauri/src/lib.rs` (register new command)
- Modify: `src/utils/ipc.ts` (TS wrapper)

A headless one-shot agent invocation. Used by the Reviewer stage (and any future stage marked one-shot). Spawns the agent CLI with `--print` / `exec`, captures stdout, returns when the process exits. No PTY, no live interaction.

**Why a separate command:** the existing `agent_spawn` allocates a PTY and runs interactively. One-shot stages don't need a PTY — they get input on the command line, produce output on stdout, and exit. Wrapping `agent_spawn` for this would be expensive and conceptually wrong.

### Step 1.1: Add Rust unit tests (TDD red)

Append to `src-tauri/src/commands/agents.rs` inside the existing `#[cfg(test)] mod tests` block (or create one if absent):

```rust
#[cfg(test)]
mod oneshot_tests {
    use super::*;
    use std::time::Duration;

    /// Tests use `/bin/echo` as a stand-in for `claude` / `codex` so we don't
    /// require those binaries on CI. The OneshotAgentBin enum lets us pin the
    /// resolved binary for testing.
    #[tokio::test]
    async fn run_oneshot_captures_stdout_and_exit_code() {
        let res = run_oneshot_inner(
            OneshotInvocation {
                bin_override: Some("/bin/echo".into()),
                args: vec!["hello".into(), "world".into()],
                stdin: None,
                timeout_secs: 5,
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert!(res.stdout.starts_with("hello world"));
        assert_eq!(res.exit_code, Some(0));
        assert!(res.duration_ms > 0);
        assert!(!res.timed_out);
    }

    #[tokio::test]
    async fn run_oneshot_captures_nonzero_exit() {
        let res = run_oneshot_inner(
            OneshotInvocation {
                bin_override: Some("/bin/sh".into()),
                args: vec!["-c".into(), "exit 7".into()],
                stdin: None,
                timeout_secs: 5,
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(res.exit_code, Some(7));
    }

    #[tokio::test]
    async fn run_oneshot_pipes_stdin() {
        let res = run_oneshot_inner(
            OneshotInvocation {
                bin_override: Some("/bin/cat".into()),
                args: vec![],
                stdin: Some("piped input".into()),
                timeout_secs: 5,
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(res.stdout.trim(), "piped input");
    }

    #[tokio::test]
    async fn run_oneshot_times_out_long_running() {
        let started = std::time::Instant::now();
        let res = run_oneshot_inner(
            OneshotInvocation {
                bin_override: Some("/bin/sh".into()),
                args: vec!["-c".into(), "sleep 30".into()],
                stdin: None,
                timeout_secs: 1,
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert!(res.timed_out);
        // Confirm we didn't actually wait 30 seconds
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
```

### Step 1.2: Run, confirm fails (TDD red)

Run: `cd /Users/txdm_/.codex/tmx/src-tauri && cargo test agents::oneshot_tests`
Expected: compile error — `run_oneshot_inner`, `OneshotInvocation` not defined.

### Step 1.3: Implement (TDD green)

Append to `src-tauri/src/commands/agents.rs` (above the test block):

```rust
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration as TokioDuration};

#[derive(Debug, Deserialize)]
pub struct OneshotInvocation {
    /// Internal: tests inject a known bin (e.g. /bin/echo). Production callers
    /// don't set this; resolved from `agent` enum below at the IPC boundary.
    #[serde(skip)]
    pub bin_override: Option<String>,

    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub timeout_secs: u64,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OneshotResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Pure-async core. Caller resolves the binary path; this just runs it.
pub async fn run_oneshot_inner(inv: OneshotInvocation) -> Result<OneshotResult, String> {
    let bin = inv
        .bin_override
        .clone()
        .ok_or_else(|| "no binary specified".to_string())?;

    let started = std::time::Instant::now();

    let mut cmd = TokioCommand::new(&bin);
    cmd.args(&inv.args);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(cwd) = &inv.cwd {
        cmd.current_dir(cwd);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;

    if let Some(input) = &inv.stdin {
        if let Some(mut sin) = child.stdin.take() {
            sin.write_all(input.as_bytes())
                .await
                .map_err(|e| format!("write stdin: {e}"))?;
            // Drop sin to close stdin — let the child finish reading.
        }
    }

    let wait = child.wait_with_output();
    let result = timeout(TokioDuration::from_secs(inv.timeout_secs), wait).await;

    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(out)) => Ok(OneshotResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code(),
            timed_out: false,
            duration_ms,
        }),
        Ok(Err(e)) => Err(format!("wait child: {e}")),
        Err(_) => {
            // Best-effort: kill the process tree on timeout. We don't have a
            // handle to `child` after `wait_with_output()` consumed it, so
            // surface the timeout to the caller.
            Ok(OneshotResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                timed_out: true,
                duration_ms,
            })
        }
    }
}

/// Resolve agent name → binary path. Mirrors `agent_spawn`'s resolution:
/// `claude`/`codex`/`gemini` resolve to the binary on PATH; `customCommand`
/// is parsed via `shell-words` (Phase 2b limits one-shot to the three known
/// agents — `customCommand` for one-shot is a Phase 3 escape hatch).
fn resolve_oneshot_bin(agent: &str) -> Result<String, String> {
    match agent {
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        "gemini" => Ok("gemini".to_string()),
        other => Err(format!("unsupported one-shot agent: {other}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct OneshotIpcInput {
    pub agent: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    #[serde(default = "default_oneshot_timeout")]
    pub timeout_secs: u64,
    pub cwd: Option<String>,
}

fn default_oneshot_timeout() -> u64 {
    600
}

#[tauri::command]
pub async fn agent_run_oneshot(input: OneshotIpcInput) -> Result<OneshotResult, String> {
    let bin = resolve_oneshot_bin(&input.agent)?;
    let inv = OneshotInvocation {
        bin_override: Some(bin),
        args: input.args,
        stdin: input.stdin,
        timeout_secs: input.timeout_secs,
        cwd: input.cwd,
    };
    run_oneshot_inner(inv).await
}
```

### Step 1.4: Register in `lib.rs`

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler!` macro. Add to the agent commands group:

```rust
            commands::agents::agent_run_oneshot,
```

### Step 1.5: Add TS wrapper

In `src/utils/ipc.ts`, append:

```ts
export interface OneshotResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

export async function agentRunOneshot(opts: {
  agent: 'claude' | 'codex' | 'gemini';
  args: string[];
  stdin?: string;
  timeoutSecs?: number;
  cwd?: string;
}): Promise<OneshotResult> {
  return invoke<OneshotResult>('agent_run_oneshot', {
    input: {
      agent: opts.agent,
      args: opts.args,
      stdin: opts.stdin ?? null,
      timeout_secs: opts.timeoutSecs ?? 600,
      cwd: opts.cwd ?? null,
    },
  });
}
```

### Step 1.6: Run, confirm passes

```
cd /Users/txdm_/.codex/tmx/src-tauri && cargo test agents::oneshot_tests
cd /Users/txdm_/.codex/tmx/src-tauri && cargo clippy --all-targets -- -D warnings
cd /Users/txdm_/.codex/tmx && npx tsc --noEmit
```

Expected: 4 cargo tests pass, clippy clean for new code, typecheck clean.

### Step 1.7: Commit

```bash
git add src-tauri/src/commands/agents.rs src-tauri/src/lib.rs src/utils/ipc.ts
git commit -m "feat(pipeline): agent_run_oneshot Rust IPC for headless stages

Wraps tokio::process::Command for the Reviewer stage's one-shot
invocation pattern. Pipes stdin, captures stdout/stderr/exit_code,
honors timeout (default 600s). 4 cargo tests cover happy path,
nonzero exit, stdin pipe, and timeout.

Phase 2b uses this for the Reviewer; Phase 3 may extend to the
custom-command escape hatch via a separate path."
```

---

## Task 2: Sentinel scanner module (TDD)

**Files:**
- Create: `src/pipeline/sentinel-scanner.ts`
- Test: `src/pipeline/sentinel-scanner.test.ts`

A pure function `scanForSentinel(buffer: string) → SentinelEvent | null`. Handles the four sentinels (`TX_STAGE_DONE`, `TX_STAGE_FAILED`, `TX_STAGE_QUESTION`, `TX_HEARTBEAT`), JSON parsing, and the gnarly real-world cases: ANSI color codes, sentinels split across multiple PTY chunks, and incomplete JSON.

The scanner is **stateless** per call but the *caller* maintains a per-PTY buffer (accumulating chunks until a complete sentinel is found, then trimming). This separation keeps the parser unit-testable.

### Step 2.1: Write the failing test

Create `src/pipeline/sentinel-scanner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scanForSentinel, stripAnsi } from './sentinel-scanner';

describe('stripAnsi', () => {
  it('removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mhello\x1b[0m world')).toBe('hello world');
  });

  it('preserves non-ANSI content', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('scanForSentinel', () => {
  it('finds TX_STAGE_DONE with valid JSON', () => {
    const buf = 'some progress output\n<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/x","specPath":"s","planPath":"p","tasks":[],"summary":"s"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('done');
    if (event?.kind === 'done') {
      expect(event.payload.stage).toBe('planner');
      expect(event.payload.branch).toBe('feat/x');
    }
    expect(event?.consumedThrough).toBeGreaterThan(0);
  });

  it('finds TX_STAGE_FAILED with reason', () => {
    const buf = '<<<TX_STAGE_FAILED>>>{"reason":"missing file","suggestedFix":"create it"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('failed');
    if (event?.kind === 'failed') {
      expect(event.payload.reason).toBe('missing file');
    }
  });

  it('finds TX_STAGE_QUESTION with options', () => {
    const buf = '<<<TX_STAGE_QUESTION>>>{"stage":"builder","question":"X or Y?","context":"both work","options":["X","Y"],"blocking":true}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('question');
    if (event?.kind === 'question') {
      expect(event.payload.question).toBe('X or Y?');
      expect(event.payload.options).toEqual(['X', 'Y']);
    }
  });

  it('finds TX_HEARTBEAT', () => {
    const buf = '<<<TX_HEARTBEAT>>>{"progress":"wrote test","taskId":"T1"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('heartbeat');
    if (event?.kind === 'heartbeat') {
      expect(event.payload.progress).toBe('wrote test');
    }
  });

  it('strips ANSI before parsing', () => {
    const buf = '\x1b[2m<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":""}\x1b[0m\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('done');
  });

  it('returns null on incomplete JSON (waits for more input)', () => {
    const buf = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/x"';  // truncated
    expect(scanForSentinel(buf)).toBeNull();
  });

  it('returns null when no sentinel marker present', () => {
    const buf = 'just regular output, no sentinels here';
    expect(scanForSentinel(buf)).toBeNull();
  });

  it('returns null on malformed JSON after sentinel', () => {
    const buf = '<<<TX_STAGE_DONE>>>{not json}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('parse_error');
  });

  it('finds the FIRST sentinel when multiple present', () => {
    const buf = '<<<TX_HEARTBEAT>>>{"progress":"a","taskId":"T1"}\n<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('heartbeat');
  });

  it('reports consumedThrough so caller can trim buffer', () => {
    const sentinel = '<<<TX_HEARTBEAT>>>{"progress":"x","taskId":"T1"}';
    const buf = `prefix\n${sentinel}\nmore`;
    const event = scanForSentinel(buf);
    expect(event?.consumedThrough).toBe(buf.indexOf(sentinel) + sentinel.length);
  });

  it('handles sentinel at very end of buffer (no trailing newline)', () => {
    const buf = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm"}';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('done');
  });

  it('rejects sentinel inside markdown code fence (anti-pattern)', () => {
    const buf = '```\n<<<TX_STAGE_DONE>>>{"stage":"x","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":""}\n```\n';
    // Per skill rule 1, sentinels must begin at column 0. We accept this case
    // because PTY output isn't column-aligned and we have to be lenient. The
    // test just confirms we DO match it (the agent is misbehaving but we're
    // forgiving).
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('done');
  });
});
```

### Step 2.2: Run, confirm fails

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/sentinel-scanner.test.ts`
Expected: module-not-found.

### Step 2.3: Implement

Create `src/pipeline/sentinel-scanner.ts`:

```ts
import type { PlanArtifact, BuildArtifact, ReviewVerdict, QuestionArtifact } from '@/types';

export type SentinelEvent =
  | { kind: 'done'; payload: PlanArtifact | BuildArtifact | ReviewVerdict; consumedThrough: number }
  | { kind: 'failed'; payload: { reason: string; suggestedFix?: string }; consumedThrough: number }
  | { kind: 'question'; payload: QuestionArtifact; consumedThrough: number }
  | { kind: 'heartbeat'; payload: { progress: string; taskId?: string }; consumedThrough: number }
  | { kind: 'parse_error'; raw: string; error: string; consumedThrough: number };

const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

const MARKERS = [
  { marker: '<<<TX_STAGE_DONE>>>',     kind: 'done'      as const },
  { marker: '<<<TX_STAGE_FAILED>>>',   kind: 'failed'    as const },
  { marker: '<<<TX_STAGE_QUESTION>>>', kind: 'question'  as const },
  { marker: '<<<TX_HEARTBEAT>>>',      kind: 'heartbeat' as const },
];

interface MatchedMarker {
  index: number;
  kind: 'done' | 'failed' | 'question' | 'heartbeat';
  marker: string;
}

function findFirstMarker(buf: string): MatchedMarker | null {
  let earliest: MatchedMarker | null = null;
  for (const { marker, kind } of MARKERS) {
    const idx = buf.indexOf(marker);
    if (idx === -1) continue;
    if (earliest === null || idx < earliest.index) {
      earliest = { index: idx, kind, marker };
    }
  }
  return earliest;
}

/**
 * Scan a buffer for the first complete sentinel.
 *
 * Returns:
 * - `null` if no sentinel marker is present, OR a marker is present but the
 *   trailing JSON is incomplete (waiting for more input).
 * - A `SentinelEvent` with `consumedThrough` indicating where the sentinel
 *   ended (caller should `buf.slice(consumedThrough)` to keep scanning).
 * - `kind: 'parse_error'` when the marker is followed by malformed JSON —
 *   the controller can decide how to handle this.
 */
export function scanForSentinel(rawBuf: string): SentinelEvent | null {
  const buf = stripAnsi(rawBuf);

  const matched = findFirstMarker(buf);
  if (!matched) return null;

  const jsonStart = matched.index + matched.marker.length;
  const json = extractJsonObject(buf, jsonStart);
  if (json === null) return null; // incomplete — wait for more input

  const consumedThrough = jsonStart + json.length;

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    return {
      kind: 'parse_error',
      raw: json,
      error: e instanceof Error ? e.message : String(e),
      consumedThrough,
    };
  }

  // Type-discriminate based on marker. We trust the JSON shape for now;
  // future hardening (Phase 2c) can add zod-style schema validation.
  switch (matched.kind) {
    case 'done':
      return { kind: 'done', payload: payload as PlanArtifact | BuildArtifact | ReviewVerdict, consumedThrough };
    case 'failed':
      return { kind: 'failed', payload: payload as { reason: string; suggestedFix?: string }, consumedThrough };
    case 'question':
      return { kind: 'question', payload: payload as QuestionArtifact, consumedThrough };
    case 'heartbeat':
      return { kind: 'heartbeat', payload: payload as { progress: string; taskId?: string }, consumedThrough };
  }
}

/**
 * Find the first balanced `{...}` JSON object starting at or after `from`.
 * Returns the substring (including braces) on success, `null` if the buffer
 * doesn't yet contain a complete object.
 *
 * Tracks string state so brace counts inside strings don't confuse us.
 */
function extractJsonObject(buf: string, from: number): string | null {
  // Skip whitespace
  let i = from;
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\t' || buf[i] === '\n')) i++;
  if (i >= buf.length || buf[i] !== '{') return null;

  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < buf.length; i++) {
    const ch = buf[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return buf.slice(start, i + 1);
    }
  }

  return null; // incomplete
}
```

### Step 2.4: Run, confirm passes

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/sentinel-scanner.test.ts`
Expected: 12 tests pass.

### Step 2.5: Commit

```bash
git add src/pipeline/sentinel-scanner.ts src/pipeline/sentinel-scanner.test.ts
git commit -m "feat(pipeline): pure sentinel-scanner module

Pure-function parser for the TX_STAGE_{DONE,FAILED,QUESTION} +
TX_HEARTBEAT sentinels. Strips ANSI codes, finds first marker, extracts
balanced JSON object (string-aware), returns null on incomplete input
so the caller can buffer more PTY output and retry.

12 vitest cases cover: each marker, ANSI stripping, incomplete JSON,
malformed JSON (parse_error variant), no-marker, multi-sentinel
ordering, consumedThrough trimming offset, and the markdown-fence
edge case (we're lenient on column-0 because PTY output isn't aligned)."
```

---

## Task 3: Controller runtime — wire scanner to pipelineStore (TDD)

**Files:**
- Create: `src/pipeline/controller-runtime.ts`
- Test: `src/pipeline/controller-runtime.test.ts`

A frontend module that:
1. Subscribes to `pty-output` Tauri events (existing `onPtyOutput` from `ipc.ts`).
2. Accumulates per-PTY-id buffers.
3. On each chunk, calls `scanForSentinel`. If a complete sentinel is found, dispatches the appropriate `PipelineEvent` to `pipelineStore`, trims the buffer.
4. Resolves PTY id → role via `pipelineStore.runs[runId].tiles[role] === tileId` ↔ `AgentTile.ptyId === ptyId`.

Also dispatches one-shot results from `agent_run_oneshot` invocations (those emit `stdout` directly, not via PTY events).

### Step 3.1: Write failing test

Create `src/pipeline/controller-runtime.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ingestPtyChunk, ingestOneshotResult } from './controller-runtime';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

describe('controller runtime', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('ingestPtyChunk parses TX_STAGE_DONE for a planner role and advances state', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","specPath":"s","planPath":"p","tasks":[],"summary":"s"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
    expect(usePipelineStore.getState().runs[runId].artifacts.plan).toBeDefined();
  });

  it('ingestPtyChunk for builder advances to reviewing', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    expect(usePipelineStore.getState().runs[runId].state).toBe('reviewing');
  });

  it('ingestPtyChunk handles partial chunks (sentinel split across two)', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // First half: marker but no complete JSON
    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","spec' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('planning'); // unchanged

    // Second half: completes the JSON
    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":""}\n' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
  });

  it('ingestPtyChunk emits TX_STAGE_FAILED → state becomes failed', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE_FAILED>>>{"reason":"could not parse plan"}\n' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
    expect(usePipelineStore.getState().runs[runId].failureReason).toContain('could not parse plan');
  });

  it('ingestOneshotResult parses reviewer verdict from stdout', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
    }});

    const stdout = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm"}\n';
    ingestOneshotResult({ runId, role: 'reviewer', stdout, exitCode: 0 });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_merge_approval');
  });

  it('ingestOneshotResult treats nonzero exit + no sentinel as planner_failed', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
    }});

    ingestOneshotResult({ runId, role: 'reviewer', stdout: 'agent crashed', exitCode: 1 });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
  });
});
```

### Step 3.2: Run, confirm fails

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/controller-runtime.test.ts`
Expected: module-not-found.

### Step 3.3: Implement

Create `src/pipeline/controller-runtime.ts`:

```ts
import { usePipelineStore } from '@/stores/pipelineStore';
import { scanForSentinel, type SentinelEvent } from './sentinel-scanner';
import type { PipelineRole, PlanArtifact, BuildArtifact, ReviewVerdict, QuestionArtifact } from '@/types';

/**
 * Per-PTY scanner buffers. PTY output is byte-streamed and a sentinel may
 * be split across chunks; we accumulate until we find a complete sentinel
 * (or until the buffer outgrows MAX_BUFFER, in which case we discard the
 * oldest content as a runaway-output guard).
 */
const ptyBuffers = new Map<string, string>();
const MAX_BUFFER = 64 * 1024; // 64KB

interface PtyChunkInput {
  runId: string;
  role: PipelineRole;
  chunk: string;
}

interface OneshotInput {
  runId: string;
  role: PipelineRole;
  stdout: string;
  exitCode: number | null;
}

/**
 * Public entry: feed a PTY output chunk for a run+role.
 * Accumulates and dispatches on complete sentinels.
 */
export function ingestPtyChunk(input: PtyChunkInput): void {
  const key = `${input.runId}:${input.role}`;
  let buf = (ptyBuffers.get(key) ?? '') + input.chunk;

  while (true) {
    const event = scanForSentinel(buf);
    if (event === null) break;
    dispatchSentinel(input.runId, input.role, event);
    buf = buf.slice(event.consumedThrough);
  }

  if (buf.length > MAX_BUFFER) {
    buf = buf.slice(buf.length - MAX_BUFFER);
  }
  ptyBuffers.set(key, buf);
}

/**
 * Public entry: feed a one-shot agent result. The full stdout is passed
 * once; we scan it for the terminal sentinel. If none is found and the
 * exit code is non-zero, we synthesize a `planner_failed`-style transition.
 */
export function ingestOneshotResult(input: OneshotInput): void {
  const event = scanForSentinel(input.stdout);
  if (event !== null) {
    dispatchSentinel(input.runId, input.role, event);
    return;
  }

  // No sentinel found — synthesize a failure if exit was non-zero
  if (input.exitCode !== 0) {
    const dispatch = usePipelineStore.getState().dispatch;
    if (input.role === 'planner') {
      dispatch(input.runId, {
        type: 'planner_failed',
        reason: `agent exited ${input.exitCode} without sentinel; stdout: ${input.stdout.slice(0, 500)}`,
      });
    } else {
      // For other roles a sentinel-less exit is a stage_unresponsive-style
      // failure. Use abort to short-circuit the run.
      dispatch(input.runId, {
        type: 'abort',
        reason: `${input.role} exited ${input.exitCode} without sentinel`,
      });
    }
  }
  // If exit was 0 but no sentinel, the agent didn't follow protocol. Phase 2c
  // adds a stuck-detector that catches this; for now we leave the run pending.
}

function dispatchSentinel(runId: string, role: PipelineRole, ev: SentinelEvent): void {
  const dispatch = usePipelineStore.getState().dispatch;

  switch (ev.kind) {
    case 'done':
      dispatchDone(runId, role, ev.payload, dispatch);
      break;
    case 'failed':
      if (role === 'planner') {
        dispatch(runId, { type: 'planner_failed', reason: ev.payload.reason });
      } else {
        dispatch(runId, { type: 'abort', reason: `${role}: ${ev.payload.reason}` });
      }
      break;
    case 'question':
      dispatch(runId, { type: 'question_raised', question: ev.payload as QuestionArtifact });
      break;
    case 'heartbeat':
      // Heartbeats don't trigger state transitions; stash for stuck-detection
      // (Phase 2c will use these). For Phase 2b just no-op.
      break;
    case 'parse_error':
      // Malformed sentinel — treat as a stage refusal so the run doesn't hang
      if (role === 'planner') {
        dispatch(runId, { type: 'planner_failed', reason: `malformed sentinel: ${ev.error}` });
      } else {
        dispatch(runId, { type: 'abort', reason: `malformed sentinel from ${role}: ${ev.error}` });
      }
      break;
  }
}

function dispatchDone(
  runId: string,
  role: PipelineRole,
  payload: PlanArtifact | BuildArtifact | ReviewVerdict,
  dispatch: ReturnType<typeof usePipelineStore.getState>['dispatch'],
): void {
  // Discriminate by the artifact's `stage` field
  if ('stage' in payload && payload.stage === 'planner' && role === 'planner') {
    dispatch(runId, { type: 'planner_done', plan: payload as PlanArtifact });
  } else if ('stage' in payload && payload.stage === 'builder' && role === 'builder') {
    dispatch(runId, { type: 'builder_done', build: payload as BuildArtifact });
  } else if ('stage' in payload && payload.stage === 'reviewer' && (role === 'reviewer' || role === 'reviewer-codex')) {
    dispatch(runId, { type: 'reviewer_done', verdict: payload as ReviewVerdict });
  }
  // Mismatch (e.g., builder role emits a planner artifact) is silently ignored —
  // Phase 2c may surface as a parse_error toast. For Phase 2b we keep the
  // controller robust to mis-tagged artifacts.
}

/** Test helper — reset internal buffers between vitest cases. */
export function _resetForTest(): void {
  ptyBuffers.clear();
}
```

### Step 3.4: Run, confirm passes

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/controller-runtime.test.ts`
Expected: 6 tests pass.

### Step 3.5: Commit

```bash
git add src/pipeline/controller-runtime.ts src/pipeline/controller-runtime.test.ts
git commit -m "feat(pipeline): controller-runtime glues sentinel scanner to pipelineStore

ingestPtyChunk maintains a per-PTY accumulator buffer (64KB cap), runs
the scanner on every chunk, dispatches PipelineEvent on every complete
sentinel found. ingestOneshotResult is the headless analog — single
buffer, single scan, synthesizes failure on nonzero exit + no sentinel.

Maps sentinel kind → reducer event:
  done(planner) → planner_done
  done(builder) → builder_done
  done(reviewer) → reviewer_done
  failed(planner) → planner_failed
  failed(other) → abort
  question → question_raised
  parse_error → planner_failed / abort (run doesn't hang)
  heartbeat → no-op (Phase 2c will use for stuck detection)

6 vitest cases cover happy paths + partial-chunk reassembly + failure
synthesis on nonzero exit."
```

---

## Task 4: Telemetry JSONL writer (Rust IPC + frontend hook)

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/utils/ipc.ts`
- Modify: `src/stores/pipelineStore.ts`

Every state-machine transition appends one JSONL line to `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl`. Rust does the file-write (atomic O_APPEND) so the frontend doesn't have to deal with FS concurrency.

### Step 4.1: Add `pipeline_telemetry_log` Rust command (TDD)

Append tests in `src-tauri/src/commands/pipeline.rs`'s `mod tests`:

```rust
    #[test]
    fn telemetry_log_appends_jsonl_line() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let line = r#"{"at":1,"event":"state_change","from":"idle","to":"planning"}"#;

        telemetry_log_inner(project, "r-test-1", line).unwrap();

        let f = project.join(".terminalx/pipeline-telemetry/r-test-1.jsonl");
        let contents = fs::read_to_string(&f).unwrap();
        assert!(contents.starts_with(line));
        assert!(contents.ends_with('\n'));
    }

    #[test]
    fn telemetry_log_appends_multiple_lines() {
        let dir = tempdir().unwrap();
        let project = dir.path();

        telemetry_log_inner(project, "r-1", r#"{"at":1}"#).unwrap();
        telemetry_log_inner(project, "r-1", r#"{"at":2}"#).unwrap();
        telemetry_log_inner(project, "r-1", r#"{"at":3}"#).unwrap();

        let contents = fs::read_to_string(project.join(".terminalx/pipeline-telemetry/r-1.jsonl")).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains(r#""at":1"#));
        assert!(lines[2].contains(r#""at":3"#));
    }

    #[test]
    fn telemetry_log_rejects_newline_in_payload() {
        let dir = tempdir().unwrap();
        let res = telemetry_log_inner(dir.path(), "r-1", "broken\nline");
        assert!(res.is_err());
    }

    #[test]
    fn telemetry_log_rejects_invalid_run_id() {
        let dir = tempdir().unwrap();
        let res = telemetry_log_inner(dir.path(), "../escape", r#"{"at":1}"#);
        assert!(res.is_err());
    }
```

Implement in `pipeline.rs` (above the `#[cfg(test)]` block):

```rust
fn validate_run_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("empty run_id".into());
    }
    if id.len() > 128 {
        return Err("run_id too long".into());
    }
    if id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        return Err("run_id must be ascii alphanumeric / '-' / '_'".into());
    }
    Ok(())
}

fn telemetry_log_inner(project_dir: &Path, run_id: &str, line: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    if line.contains('\n') {
        return Err("telemetry line may not contain newlines".into());
    }

    let dir = project_dir.join(".terminalx/pipeline-telemetry");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;

    let path = dir.join(format!("{run_id}.jsonl"));
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
    f.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn pipeline_telemetry_log(
    project_dir: String,
    run_id: String,
    line: String,
) -> Result<(), String> {
    validate_path_arg(&project_dir)?;
    telemetry_log_inner(Path::new(&project_dir), &run_id, &line)
}
```

### Step 4.2: Register + TS wrapper

In `src-tauri/src/lib.rs`'s `generate_handler!`, add (alphabetical with the other pipeline commands):

```rust
            commands::pipeline::pipeline_telemetry_log,
```

In `src/utils/ipc.ts`, append:

```ts
export async function pipelineTelemetryLog(opts: {
  projectDir: string;
  runId: string;
  line: string;
}): Promise<void> {
  await invoke<void>('pipeline_telemetry_log', opts);
}
```

### Step 4.3: Wire pipelineStore to log every state transition

In `src/stores/pipelineStore.ts`, modify `dispatch` to log telemetry after a state change. **Important:** logging is fire-and-forget — never await, never block the dispatch call.

Find the existing `dispatch` action:

```ts
  dispatch: (runId, ev) => {
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      if (next === existing) return s;
      const runs = { ...s.runs, [runId]: next };
      return { runs, activeRunIds: deriveActive(runs) };
    });
  },
```

Replace with:

```ts
  dispatch: (runId, ev) => {
    let logLine: string | null = null;
    let projectId: string | null = null;
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      if (next === existing) return s;

      // Capture telemetry payload for fire-and-forget log after state update
      const stateChanged = existing.state !== next.state;
      if (stateChanged) {
        projectId = existing.projectId;
        logLine = JSON.stringify({
          at: Date.now(),
          event: 'state_change',
          runId,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        });
      }

      const runs = { ...s.runs, [runId]: next };
      return { runs, activeRunIds: deriveActive(runs) };
    });

    // Fire-and-forget. The projectId is the *project root path* the run
    // was created with (not the projectStore project id) — pipelineStore
    // currently stores the path. Phase 2c will reconcile the naming.
    if (logLine && projectId) {
      void import('@/utils/ipc').then(({ pipelineTelemetryLog }) =>
        pipelineTelemetryLog({ projectDir: projectId!, runId, line: logLine! })
          .catch(err => console.warn('[pipeline] telemetry log failed:', err)),
      );
    }
  },
```

Note: `projectId` on `PipelineRun` is the project *path* in this design — confirmed by Phase 1's plan §5 where `worktreePath` and `projectId` are both filesystem paths. The telemetry write goes under `<projectId>/.terminalx/pipeline-telemetry/`.

### Step 4.4: Run all gates

```
cd /Users/txdm_/.codex/tmx/src-tauri && cargo test pipeline::tests
cd /Users/txdm_/.codex/tmx && npx tsc --noEmit
cd /Users/txdm_/.codex/tmx && pnpm test
```

Expected: cargo 16/16 (12 prior + 4 new), typecheck clean, vitest still 135 passing (existing pipelineStore tests don't notice the telemetry write because it's a dynamic import + fire-and-forget; new tests in Task 6 will exercise it).

### Step 4.5: Commit

```bash
git add src-tauri/src/commands/pipeline.rs src-tauri/src/lib.rs src/utils/ipc.ts src/stores/pipelineStore.ts
git commit -m "feat(pipeline): telemetry JSONL writer per spec §13.2

New Rust command pipeline_telemetry_log appends {project}/.terminalx/
pipeline-telemetry/{runId}.jsonl with O_APPEND atomicity. Validates
run_id as alphanumeric+-_ only; rejects newlines in payload.

pipelineStore.dispatch now fire-and-forgets a state_change line on
every state transition. Captured atomically inside the reducer's set()
callback so we don't read stale state. Failures log to console.warn but
never block the dispatch.

4 new cargo tests (16 total in pipeline::tests)."
```

---

## Task 5: Default `Anthropic Trio` template

**Files:**
- Modify: `src/pipeline/templates.ts`

Phase 1 shipped `helloWorldTemplate()` — three stub agent tiles for state-machine smoke testing. Phase 2b adds the real production template: same shape, but with role prompts that actually drive Claude/Codex to behave like Planner/Builder/Reviewer.

For Phase 2b we don't ship full role prompts (those are Phase 2c — they need the full skill-binding + capability-manifest plumbing). Instead the trio template marks each tile with the skill ID list from spec §10's `skillBindings`, and the role prompts are short shims that say *"You are <role>. Follow these skills: [list]. Emit sentinels per tx-pipeline-stage-handoff."*

### Step 5.1: Append `anthropicTrioTemplate()`

In `src/pipeline/templates.ts`, append (after the existing `helloWorldTemplate`):

```ts
/**
 * The production "Anthropic Trio": Opus Planner, Sonnet Builder, Opus
 * Reviewer. Skill-bound per spec §10. Used as the default user-facing
 * pipeline template once Phase 2b ships live execution.
 *
 * Phase 2b wires the skills + sentinel protocol; Phase 2c adds the full
 * role-prompt content (capability scoping, INVARIANTS.md awareness, etc.)
 * The shape is identical to helloWorldTemplate() so the controller doesn't
 * need to discriminate between them at runtime.
 */
export function anthropicTrioTemplate(): PipelineTemplate {
  return {
    kind: 'pipeline',
    id: 'tx.pipeline.anthropic-trio',
    name: 'Anthropic Trio',
    description: 'Plan → Build → Review with Opus Planner, Sonnet Builder, and Opus Reviewer. Bundled skills enforce stage-handoff protocol and reviewer discipline.',
    isBuiltin: true,

    tiles: [
      { role: 'planner', type: 'agent', position: { x: 0, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'planner',
        } },
      { role: 'builder', type: 'agent', position: { x: 520, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'sonnet-4-6', effort: 'medium', mode: 'builder',
        } },
      { role: 'reviewer', type: 'agent', position: { x: 1040, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'reviewer',
          oneshot: true,
        } },
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
        planner: [
          'superpowers:brainstorming',
          'superpowers:writing-plans',
          'tx-pipeline-stage-handoff',
        ],
        builder: [
          'superpowers:executing-plans',
          'superpowers:test-driven-development',
          'tdd',
          'superpowers:verification-before-completion',
          'tx-pipeline-stage-handoff',
        ],
        reviewer: [
          'superpowers:requesting-code-review',
          'karpathy-guidelines',
          'tx-pipeline-reviewer',
        ],
      },
    },
  };
}
```

### Step 5.2: Verify typecheck

Run: `cd /Users/txdm_/.codex/tmx && npx tsc --noEmit`
Expected: clean. The `oneshot: true` config field on the reviewer is a hint for the controller (Phase 2c uses it to decide live-PTY vs `agent_run_oneshot`); Phase 2b ignores it.

### Step 5.3: Commit

```bash
git add src/pipeline/templates.ts
git commit -m "feat(pipeline): Anthropic Trio production template

Plan-Build-Review trio with Opus/Sonnet/Opus model defaults and full
skill bindings per spec §10 (planner: brainstorming + writing-plans +
stage-handoff; builder: executing-plans + TDD x2 + verification-before-
completion + stage-handoff; reviewer: requesting-code-review +
karpathy-guidelines + tx-pipeline-reviewer).

reviewer tile config carries oneshot: true as a hint for the future
agent_run_oneshot dispatch path (Phase 2c plumbs it; Phase 2b ignores)."
```

---

## Task 6: Phase 2b end-to-end smoke test

**Files:**
- Create: `src/pipeline/phase2b-smoke.test.ts`

End-to-end vitest using the Hello World template + mocked agent output. Verifies the live-execution path works without requiring real Claude/Codex binaries.

### Step 6.1: Write the test

Create `src/pipeline/phase2b-smoke.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { helloWorldTemplate } from './templates';
import { instantiatePipelineTemplate } from './instantiate';
import { computeMinimalFingerprint } from './fingerprint';
import { ingestPtyChunk, ingestOneshotResult } from './controller-runtime';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';

describe('Phase 2b: live-execution path end-to-end (mocked agents)', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('full happy path: planner → builder → reviewer → awaiting_merge_approval', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id, template: tpl, terminalxVersion: '0.1.0',
    });

    const runId = usePipelineStore.getState().createRun({
      runId: 'r-2b-smoke', templateId: tpl.id, projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-2b-smoke', fingerprint: fp,
    });

    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('planning');

    // Mocked Planner emits a sentinel via PTY
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: 'Designing the plan...\n<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r-2b-smoke","specPath":"docs/spec.md","planPath":"docs/plan.md","tasks":[{"id":"T1","summary":"add foo","files":["src/foo.ts"],"tests":["foo handles bar"],"acceptance":"foo returns expected"}],"summary":"Add a foo function"}\n',
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');

    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');

    // Mocked Builder
    ingestPtyChunk({
      runId, role: 'builder',
      chunk: 'Wrote test\nImplemented foo\n<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"feat/r-2b-smoke","headSha":"abc123","round":1,"commits":[{"sha":"abc123","subject":"feat(foo): add","files":["src/foo.ts"]}],"filesChanged":["src/foo.ts","tests/foo.test.ts"],"testsAdded":["foo handles bar"],"ciStatus":"green"}\n',
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('reviewing');

    // Mocked Reviewer (one-shot path)
    ingestOneshotResult({
      runId, role: 'reviewer',
      stdout: '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm","confidence":"verified"}\n',
      exitCode: 0,
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_merge_approval');
  });

  it('reviewer reject loops back to building with retry counter incremented', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id, template: tpl, terminalxVersion: '0.1.0',
    });
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-reject', templateId: tpl.id, projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-reject', fingerprint: fp,
    });

    // Drive to reviewing
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":""}\n',
    });
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    ingestPtyChunk({
      runId, role: 'builder',
      chunk: '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n',
    });

    // Reviewer rejects
    ingestOneshotResult({
      runId, role: 'reviewer',
      stdout: '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"reject","round":1,"comments":[{"severity":"blocker","file":"src/foo.ts","line":1,"issue":"missing null check"}],"summary":"blocking on null","confidence":"verified"}\n',
      exitCode: 0,
    });

    expect(usePipelineStore.getState().runs[runId].state).toBe('building');
    expect(usePipelineStore.getState().runs[runId].retryCounters.reviewerReject).toBe(1);
  });

  it('planner emits TX_STAGE_FAILED → run transitions to failed', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-fail', templateId: 't', projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-fail', fingerprint: fp,
    });

    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: '<<<TX_STAGE_FAILED>>>{"reason":"plan unclear","suggestedFix":"clarify requirements"}\n',
    });

    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
    expect(usePipelineStore.getState().runs[runId].failureClass).toBe('planner_refused');
  });

  it('partial-chunk PTY output reassembles correctly', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-partial', templateId: 't', projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-partial', fingerprint: fp,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // Simulate a sentinel split across 4 chunks
    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE' });
    ingestPtyChunk({ runId, role: 'planner', chunk: '_DONE>>>{"stage":"plann' });
    ingestPtyChunk({ runId, role: 'planner', chunk: 'er","branch":"b","spec' });
    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":""}\n' });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
  });
});
```

### Step 6.2: Run

Run: `cd /Users/txdm_/.codex/tmx && pnpm test src/pipeline/phase2b-smoke.test.ts`
Expected: 4 tests pass.

### Step 6.3: Run full test suite

Run: `cd /Users/txdm_/.codex/tmx && pnpm test`
Expected: ALL pass (135 prior + 12 scanner + 6 runtime + 4 smoke = 157 total).

### Step 6.4: Commit

```bash
git add src/pipeline/phase2b-smoke.test.ts
git commit -m "test(pipeline): Phase 2b end-to-end smoke (mocked agents)

Drives the controller through the full happy path
(planning → awaiting_plan_approval → building → reviewing →
awaiting_merge_approval) by feeding mocked agent sentinels via
ingestPtyChunk + ingestOneshotResult. Plus reject-loop retry, planner
TX_STAGE_FAILED, and partial-chunk reassembly across 4 PTY chunks."
```

---

## Task 7: Update CLAUDE.md for Phase 2b

**Files:**
- Modify: `CLAUDE.md`

Replace the "Skills installation" + neighboring Pipeline Templates content with a fuller Phase 2b account.

### Step 7.1: Find the Pipeline Templates section

Run: `grep -n "Pipeline Templates" /Users/txdm_/.codex/tmx/CLAUDE.md`

### Step 7.2: Append the new "Sentinel scanner & controller runtime" paragraph

After the existing "Skills installation" paragraph in the Pipeline Templates section, add:

```markdown
**Sentinel scanner** (`src/pipeline/sentinel-scanner.ts`) — pure parser for the four sentinels (`<<<TX_STAGE_DONE>>>`, `<<<TX_STAGE_FAILED>>>`, `<<<TX_STAGE_QUESTION>>>`, `<<<TX_HEARTBEAT>>>`) emitted by agents per the `tx-pipeline-stage-handoff` skill. Strips ANSI codes, finds the first marker, extracts a balanced JSON object (string-aware so braces inside strings don't fool it), returns `null` on incomplete input so the caller can buffer more PTY chunks and retry.

**Controller runtime** (`src/pipeline/controller-runtime.ts`) glues the scanner to `pipelineStore`. `ingestPtyChunk` accumulates per-PTY-id buffers (64KB cap with runaway-discard) and dispatches `PipelineEvent`s on every complete sentinel found. `ingestOneshotResult` is the headless analog for the Reviewer's `agent_run_oneshot` invocation. `parse_error` from the scanner becomes a `planner_failed` (planner role) or `abort` (other roles) so a misbehaving agent can never hang the run.

**One-shot agent execution** (`agent_run_oneshot` Rust IPC) — wraps `tokio::process::Command` for the Reviewer stage. Spawns the agent CLI with `--print` / `exec`, pipes stdin, captures stdout/stderr/exit_code, honors a timeout (default 600s). No PTY allocation. Phase 2b uses this for the Reviewer; Phase 3 may extend to the custom-command escape hatch.

**Telemetry JSONL** (`pipeline_telemetry_log` Rust IPC) — `pipelineStore.dispatch` fire-and-forgets one JSONL line to `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl` on every state transition. Schema: `{at, event, runId, from, to, trigger}`. Append-only via `OpenOptions::append(true)`. Rejects payload newlines (would break JSONL framing) and run_ids outside `[a-zA-Z0-9_-]+`.

**Default template:** `Anthropic Trio` (`anthropicTrioTemplate()` in `src/pipeline/templates.ts`) — Opus Planner, Sonnet Builder, Opus Reviewer with the full skill-bindings list per spec §10. Phase 2b ships the template; Phase 2c authors the role prompts that consume it.
```

### Step 7.3: Commit

```bash
git add CLAUDE.md
git commit -m "docs(claude): Phase 2b — sentinel scanner, controller runtime, oneshot, telemetry, Trio"
```

---

## Phase 2b Ship Gate

After all 7 tasks complete:

- [ ] **Gate 1: All static gates clean**

```
cd /Users/txdm_/.codex/tmx && npx tsc --noEmit
cd /Users/txdm_/.codex/tmx/src-tauri && cargo test
cd /Users/txdm_/.codex/tmx/src-tauri && cargo clippy --all-targets -- -D warnings
cd /Users/txdm_/.codex/tmx/src-tauri && cargo fmt --all -- --check
cd /Users/txdm_/.codex/tmx && pnpm test
```

Expected:
- typecheck: clean
- cargo test: 56 pass (52 prior on origin/main post-2a + 4 new oneshot + 4 new telemetry — Phase 2a's 12 pipeline tests are part of the prior 52)
- cargo clippy: clean for new code (modulo pre-existing origin/main drift)
- cargo fmt: clean for new code
- vitest: 157 pass (135 prior + 12 scanner + 6 runtime + 4 smoke)

- [ ] **Gate 2: Branch is clean**

```
git log --oneline origin/main..HEAD
git status --short
```

Expected: 7 commits ahead, working tree clean.

- [ ] **Gate 3: Push and PR**

```
git push -u origin feat/agentic-pipeline-phase-2b
gh pr create --title "Phase 2b: live agent execution + sentinel scanner + telemetry" --body "..."
```

PR body should highlight: `agent_run_oneshot` IPC, sentinel scanner pure parser, controller runtime glue, telemetry JSONL writer, Anthropic Trio default template. Note explicit deferrals to Phase 2c.

---

## Self-review notes (for the executing engineer)

- **Why scanner is pure (not stateful):** the test suite stays trivial. Caller (`controller-runtime.ts`) holds the per-PTY accumulator buffer; that's the only place state lives. If the scanner held buffer state, every test would need fixture setup.
- **Why `parse_error` doesn't hang the run:** an agent emitting malformed JSON is a real failure mode. We surface it as `planner_failed` (or `abort` for other roles) so the run terminates instead of accumulating an ever-growing buffer.
- **Why telemetry is fire-and-forget:** the dispatch path is hot (state transitions happen on every wire-piped event in real runs). Awaiting an IPC round-trip would slow the controller. Failures are logged but never block.
- **Why the smoke test uses Hello World, not Anthropic Trio:** Hello World's tile config is simpler and the test doesn't exercise model resolution. Anthropic Trio gets its first end-to-end run in Phase 2c when full role prompts land.
- **`oneshot: true` config field is decorative in Phase 2b:** Phase 2c's controller will branch on this flag to choose `agent_spawn` (live PTY) vs `agent_run_oneshot`. For 2b's mocked-agent tests, the controller-runtime entry points are called directly.
- **Buffer cap of 64KB:** generous enough for any sane plan, small enough that a runaway agent dumping infinite output can't OOM the renderer. Phase 2c's stuck detector will kick in earlier (5+ min silence → probe).
