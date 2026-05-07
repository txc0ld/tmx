import type { PlanArtifact, BuildArtifact, ReviewVerdict, QuestionArtifact } from '@/types';

export { stripAnsi } from '@/utils/ansi';
import { stripAnsi } from '@/utils/ansi';

export type SubagentDonePayload = {
  filesEdited: string[];
  commitsCreated: string[];
  summary: string;
};

export type SubagentFailedPayload = {
  reason: string;
  suggestedFix: string;
};

export type SentinelEvent =
  | { kind: 'done'; payload: PlanArtifact | BuildArtifact | ReviewVerdict; consumedThrough: number }
  | { kind: 'failed'; payload: { reason: string; suggestedFix?: string }; consumedThrough: number }
  | { kind: 'question'; payload: QuestionArtifact; consumedThrough: number }
  | { kind: 'heartbeat'; payload: { progress: string; taskId?: string }; consumedThrough: number }
  | { kind: 'subagent_done'; payload: SubagentDonePayload; consumedThrough: number }
  | { kind: 'subagent_failed'; payload: SubagentFailedPayload; consumedThrough: number }
  | { kind: 'parse_error'; raw: string; error: string; consumedThrough: number };

const MARKERS = [
  { marker: '<<<TX_STAGE_DONE>>>',     kind: 'done'             as const },
  { marker: '<<<TX_STAGE_FAILED>>>',   kind: 'failed'           as const },
  { marker: '<<<TX_STAGE_QUESTION>>>', kind: 'question'         as const },
  { marker: '<<<TX_HEARTBEAT>>>',      kind: 'heartbeat'        as const },
  { marker: '<<<TX_SUBAGENT_DONE>>>',  kind: 'subagent_done'    as const },
  { marker: '<<<TX_SUBAGENT_FAILED>>>', kind: 'subagent_failed' as const },
];

type SentinelKind = (typeof MARKERS)[number]['kind'];

interface MatchedMarker {
  index: number;
  kind: SentinelKind;
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

  switch (matched.kind) {
    case 'done':
      return { kind: 'done', payload: payload as PlanArtifact | BuildArtifact | ReviewVerdict, consumedThrough };
    case 'failed':
      return { kind: 'failed', payload: payload as { reason: string; suggestedFix?: string }, consumedThrough };
    case 'question':
      return { kind: 'question', payload: payload as QuestionArtifact, consumedThrough };
    case 'heartbeat':
      return { kind: 'heartbeat', payload: payload as { progress: string; taskId?: string }, consumedThrough };
    case 'subagent_done':
      return { kind: 'subagent_done', payload: payload as SubagentDonePayload, consumedThrough };
    case 'subagent_failed':
      return { kind: 'subagent_failed', payload: payload as SubagentFailedPayload, consumedThrough };
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
