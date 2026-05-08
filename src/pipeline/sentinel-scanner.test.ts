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
    if (event?.kind === 'done' && event.payload.stage === 'planner') {
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
    const buf = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/x"';
    expect(scanForSentinel(buf)).toBeNull();
  });

  it('returns null when no sentinel marker present', () => {
    const buf = 'just regular output, no sentinels here';
    expect(scanForSentinel(buf)).toBeNull();
  });

  it('returns parse_error variant on malformed JSON after sentinel', () => {
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

  it('handles sentinel inside markdown code fence (lenient — agent misbehaving but we forgive)', () => {
    const buf = '```\n<<<TX_STAGE_DONE>>>{"stage":"x","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":""}\n```\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('done');
  });

  // Polish.2: invocation-boundary sentinel emitted before agent_run_oneshot.
  it('finds TX_SUBAGENT_INVOKED with taskId/briefSummary/workingFiles payload', () => {
    const buf = 'about to delegate...\n<<<TX_SUBAGENT_INVOKED>>>{"taskId":"T7","briefSummary":"refactor auth helper","workingFiles":["src/auth/**","tests/auth/**"]}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('subagent_invoked');
    if (event?.kind === 'subagent_invoked') {
      expect(event.payload.taskId).toBe('T7');
      expect(event.payload.briefSummary).toBe('refactor auth helper');
      expect(event.payload.workingFiles).toEqual(['src/auth/**', 'tests/auth/**']);
    }
  });

  it('TX_SUBAGENT_INVOKED with only workingFiles is valid', () => {
    const buf = '<<<TX_SUBAGENT_INVOKED>>>{"workingFiles":["src/foo/**"]}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('subagent_invoked');
    if (event?.kind === 'subagent_invoked') {
      expect(event.payload.taskId).toBeUndefined();
      expect(event.payload.briefSummary).toBeUndefined();
      expect(event.payload.workingFiles).toEqual(['src/foo/**']);
    }
  });

  // Phase 3b.5: sub-agent sentinels emitted by tx-pipeline-subagent.
  it('finds TX_SUBAGENT_DONE with files/commits/summary payload', () => {
    const buf = 'sub-agent log...\n<<<TX_SUBAGENT_DONE>>>{"filesEdited":["src/foo.ts","src/bar.ts"],"commitsCreated":["abc1234"],"summary":"refactored helper"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('subagent_done');
    if (event?.kind === 'subagent_done') {
      expect(event.payload.filesEdited).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(event.payload.commitsCreated).toEqual(['abc1234']);
      expect(event.payload.summary).toBe('refactored helper');
    }
    expect(event?.consumedThrough).toBeGreaterThan(0);
  });

  it('finds TX_SUBAGENT_FAILED with reason + suggestedFix', () => {
    const buf = '<<<TX_SUBAGENT_FAILED>>>{"reason":"could not locate file","suggestedFix":"pass an absolute path"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('subagent_failed');
    if (event?.kind === 'subagent_failed') {
      expect(event.payload.reason).toBe('could not locate file');
      expect(event.payload.suggestedFix).toBe('pass an absolute path');
    }
  });

  it('returns parse_error on malformed JSON after TX_SUBAGENT_DONE', () => {
    const buf = '<<<TX_SUBAGENT_DONE>>>{not json at all}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('parse_error');
  });

  it('scans multiple sub-agent sentinels in one chunk sequentially', () => {
    const first  = '<<<TX_SUBAGENT_DONE>>>{"filesEdited":["a.ts"],"commitsCreated":["c1"],"summary":"one"}';
    const second = '<<<TX_SUBAGENT_DONE>>>{"filesEdited":["b.ts"],"commitsCreated":["c2"],"summary":"two"}';
    const buf = `${first}\n${second}\n`;

    const ev1 = scanForSentinel(buf);
    expect(ev1?.kind).toBe('subagent_done');
    if (ev1?.kind === 'subagent_done') {
      expect(ev1.payload.summary).toBe('one');
    }

    // Caller trims past consumedThrough and rescans — same path the controller takes.
    const tail = buf.slice(ev1!.consumedThrough);
    const ev2 = scanForSentinel(tail);
    expect(ev2?.kind).toBe('subagent_done');
    if (ev2?.kind === 'subagent_done') {
      expect(ev2.payload.summary).toBe('two');
    }
  });

  // Phase 3b.6: compaction-done sentinel.
  it('finds TX_COMPACTION_DONE with summary payload', () => {
    const buf = '<<<TX_COMPACTION_DONE>>>{"summary":"compacted: tasks 1-3 done; task 4 next"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('compaction_done');
    if (event?.kind === 'compaction_done') {
      expect(event.payload.summary).toBe('compacted: tasks 1-3 done; task 4 next');
    }
    expect(event?.consumedThrough).toBeGreaterThan(0);
  });

  // Phase 3c.6: red-team sentinels.
  it('finds TX_REDTEAM_DONE with findings + summary + confidence', () => {
    const buf =
      '<<<TX_REDTEAM_DONE>>>{"stage":"red-team","findings":[{"severity":"concern","category":"supply-chain","description":"new dep `foo` not pinned","file":"package.json","line":42}],"summary":"one supply-chain concern","confidence":"verified"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('redteam_done');
    if (event?.kind === 'redteam_done') {
      expect(event.payload.stage).toBe('red-team');
      expect(event.payload.findings).toHaveLength(1);
      expect(event.payload.findings[0].severity).toBe('concern');
      expect(event.payload.findings[0].category).toBe('supply-chain');
      expect(event.payload.summary).toBe('one supply-chain concern');
      expect(event.payload.confidence).toBe('verified');
    }
    expect(event?.consumedThrough).toBeGreaterThan(0);
  });

  it('finds TX_REDTEAM_DONE with empty findings (clean diff)', () => {
    const buf =
      '<<<TX_REDTEAM_DONE>>>{"stage":"red-team","findings":[],"summary":"clean","confidence":"verified"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('redteam_done');
    if (event?.kind === 'redteam_done') {
      expect(event.payload.findings).toEqual([]);
    }
  });

  it('finds TX_REDTEAM_FAILED with reason', () => {
    const buf =
      '<<<TX_REDTEAM_FAILED>>>{"reason":"could not access diff","suggestedFix":"re-run after merging base"}\n';
    const event = scanForSentinel(buf);
    expect(event?.kind).toBe('redteam_failed');
    if (event?.kind === 'redteam_failed') {
      expect(event.payload.reason).toBe('could not access diff');
      expect(event.payload.suggestedFix).toBe('re-run after merging base');
    }
  });

  it('ignores sentinels that are not at column 0 (role-prompt echo)', () => {
    // Reproduces a live bug: when role-prompt-injection writes a prompt
    // containing a sentinel example, Claude's UI re-renders it inside a
    // box-drawn frame with leading `│ ` characters. The scanner must
    // reject those — they're documentation, not protocol emits. The
    // template placeholder `<n>` would also explode the JSON parser.
    const echoed =
      '│ Some context.\n' +
      '│   <<<TX_STAGE_DONE>>>{"stage":"reviewer","verdict":"approve","round":1}\n' +
      '│ More text.\n';
    expect(scanForSentinel(echoed)).toBeNull();
  });

  it('ignores sentinels embedded mid-line', () => {
    const inline = 'thinking aloud about <<<TX_STAGE_DONE>>>{"x":1} format\n';
    expect(scanForSentinel(inline)).toBeNull();
  });

  it('finds the column-0 sentinel when an earlier inline match exists', () => {
    const mixed =
      'mid-line: <<<TX_STAGE_DONE>>>{"bad":1}\n' +
      '<<<TX_STAGE_DONE>>>{"stage":"planner","specPath":"a","planPath":"b","tasks":[],"summary":"x","planCommitSha":"abc","confidence":"verified"}\n';
    const event = scanForSentinel(mixed);
    expect(event?.kind).toBe('done');
  });
});
