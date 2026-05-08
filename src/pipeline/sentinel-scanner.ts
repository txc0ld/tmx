import type { PlanArtifact, BuildArtifact, ReviewVerdict, QuestionArtifact, RedTeamReport } from '@/types';

export { stripAnsi } from '@/utils/ansi';
import { stripAnsi } from '@/utils/ansi';

export type SubagentInvokedPayload = {
  /** PlanTask.id from the brief, when delegating per a specific task. */
  taskId?: string;
  /** ≤120-char one-liner from the brief, for telemetry/audit. */
  briefSummary?: string;
  /** File globs the sub-agent declares it'll touch. */
  workingFiles: string[];
};

export type SubagentDonePayload = {
  filesEdited: string[];
  commitsCreated: string[];
  summary: string;
};

export type SubagentFailedPayload = {
  reason: string;
  suggestedFix: string;
};

export type CompactionDonePayload = {
  summary: string;
};

export type SentinelEvent =
  | { kind: 'done'; payload: PlanArtifact | BuildArtifact | ReviewVerdict; consumedThrough: number }
  | { kind: 'failed'; payload: { reason: string; suggestedFix?: string }; consumedThrough: number }
  | { kind: 'question'; payload: QuestionArtifact; consumedThrough: number }
  | { kind: 'heartbeat'; payload: { progress: string; taskId?: string }; consumedThrough: number }
  | { kind: 'subagent_invoked'; payload: SubagentInvokedPayload; consumedThrough: number }
  | { kind: 'subagent_done'; payload: SubagentDonePayload; consumedThrough: number }
  | { kind: 'subagent_failed'; payload: SubagentFailedPayload; consumedThrough: number }
  | { kind: 'compaction_done'; payload: CompactionDonePayload; consumedThrough: number }
  | { kind: 'redteam_done'; payload: RedTeamReport; consumedThrough: number }
  | { kind: 'redteam_failed'; payload: { reason: string; suggestedFix?: string }; consumedThrough: number }
  | { kind: 'parse_error'; raw: string; error: string; consumedThrough: number };

const MARKERS = [
  { marker: '<<<TX_STAGE_DONE>>>',     kind: 'done'             as const },
  { marker: '<<<TX_STAGE_FAILED>>>',   kind: 'failed'           as const },
  { marker: '<<<TX_STAGE_QUESTION>>>', kind: 'question'         as const },
  { marker: '<<<TX_HEARTBEAT>>>',      kind: 'heartbeat'        as const },
  { marker: '<<<TX_SUBAGENT_INVOKED>>>', kind: 'subagent_invoked' as const },
  { marker: '<<<TX_SUBAGENT_DONE>>>',  kind: 'subagent_done'    as const },
  { marker: '<<<TX_SUBAGENT_FAILED>>>', kind: 'subagent_failed' as const },
  { marker: '<<<TX_COMPACTION_DONE>>>', kind: 'compaction_done' as const },
  { marker: '<<<TX_REDTEAM_DONE>>>',   kind: 'redteam_done'     as const },
  { marker: '<<<TX_REDTEAM_FAILED>>>', kind: 'redteam_failed'   as const },
];

type SentinelKind = (typeof MARKERS)[number]['kind'];

interface MatchedMarker {
  index: number;
  kind: SentinelKind;
  marker: string;
}

/**
 * The protocol requires sentinels on their own line at column 0. Anchoring
 * the search to a line-start guard rejects false positives from sources
 * like role-prompt echoes (Claude's UI renders pasted prompts inside
 * box-drawn frames with leading `│ ` characters, so embedded sentinel
 * examples — including ones with template placeholders that don't parse
 * as JSON, like `"round":<n>` — never appear at column 0).
 *
 * A match at buffer-start (index 0) is also valid, since chunk boundaries
 * may split exactly before a sentinel and the previous newline sits in a
 * consumed earlier slice.
 */
function isAtLineStart(buf: string, index: number): boolean {
  if (index === 0) return true;
  const prev = buf[index - 1];
  return prev === '\n' || prev === '\r';
}

function findFirstMarker(buf: string): MatchedMarker | null {
  let earliest: MatchedMarker | null = null;
  for (const { marker, kind } of MARKERS) {
    let from = 0;
    while (from < buf.length) {
      const idx = buf.indexOf(marker, from);
      if (idx === -1) break;
      if (isAtLineStart(buf, idx)) {
        if (earliest === null || idx < earliest.index) {
          earliest = { index: idx, kind, marker };
        }
        break;
      }
      from = idx + 1;
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

  switch (matched.kind) {
    case 'done':
      return { kind: 'done', payload: payload as PlanArtifact | BuildArtifact | ReviewVerdict, consumedThrough };
    case 'failed':
      return { kind: 'failed', payload: payload as { reason: string; suggestedFix?: string }, consumedThrough };
    case 'question':
      return { kind: 'question', payload: payload as QuestionArtifact, consumedThrough };
    case 'heartbeat':
      return { kind: 'heartbeat', payload: payload as { progress: string; taskId?: string }, consumedThrough };
    case 'subagent_invoked':
      return { kind: 'subagent_invoked', payload: payload as SubagentInvokedPayload, consumedThrough };
    case 'subagent_done':
      return { kind: 'subagent_done', payload: payload as SubagentDonePayload, consumedThrough };
    case 'subagent_failed':
      return { kind: 'subagent_failed', payload: payload as SubagentFailedPayload, consumedThrough };
    case 'compaction_done':
      return { kind: 'compaction_done', payload: payload as CompactionDonePayload, consumedThrough };
    case 'redteam_done':
      return { kind: 'redteam_done', payload: payload as RedTeamReport, consumedThrough };
    case 'redteam_failed':
      return { kind: 'redteam_failed', payload: payload as { reason: string; suggestedFix?: string }, consumedThrough };
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

  return null;
}
