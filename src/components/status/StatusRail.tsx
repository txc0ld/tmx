import { useState, useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useRecordingStore } from '@/stores/recordingStore';
import { gitStatus } from '@/utils/ipc';
import { colors, spacing, typography, fonts, radius, motion } from '@/design/tokens';
import { ThemePicker } from './ThemePicker';
import type { CanvasTransform } from '@/types';

const EMPTY_ARR: never[] = [];
const DEFAULT_TRANSFORM: CanvasTransform = { x: 0, y: 0, scale: 1 };

export function StatusRail() {
  const activeProject = useCanvasStore(s => s.activeProject);
  const tilesMap = useCanvasStore(s => s.tiles);
  const wiresMap = useCanvasStore(s => s.wires);
  const transformsMap = useCanvasStore(s => s.transforms);
  const tileCount = (tilesMap[activeProject] ?? EMPTY_ARR).length;
  const wireCount = (wiresMap[activeProject] ?? EMPTY_ARR).length;
  const transform = transformsMap[activeProject] ?? DEFAULT_TRANSFORM;
  const zoomPercent = Math.round(transform.scale * 100) + '%';
  const projects = useProjectStore(s => s.projects);
  const project = projects.find(p => p.id === activeProject);

  const [elapsed, setElapsed] = useState(0);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(false);
  const gitTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Poll git status every 10s
  useEffect(() => {
    if (gitTimer.current) clearInterval(gitTimer.current);
    setGitBranch(null);
    setGitDirty(false);

    const cwd = project?.cwd;
    if (!cwd) return;

    const poll = () => {
      gitStatus(cwd).then(res => {
        setGitBranch(res.branch);
        setGitDirty(res.dirty);
      }).catch(() => {
        setGitBranch(null);
        setGitDirty(false);
      });
    };

    poll();
    gitTimer.current = setInterval(poll, 10_000);
    return () => {
      if (gitTimer.current) clearInterval(gitTimer.current);
    };
  }, [project?.cwd]);

  const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');

  return (
    <div style={{
      height: 28,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${spacing.md}`,
      background: colors.surfaceLowest,
      borderTop: `1px solid ${colors.outlineGhost}`,
      gap: spacing.lg,
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {project && (
        <>
          <span style={{ ...typography.labelSm, color: project.color }}>
            {project.name}
          </span>
          {project.cwd && (
            <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono, opacity: 0.7 }}>
              {project.cwd}
            </span>
          )}
        </>
      )}

      <span style={{ ...typography.labelSm, color: colors.secondary }}>
        {tileCount} tile{tileCount !== 1 ? 's' : ''}
      </span>

      {wireCount > 0 && (
        <span style={{ ...typography.labelSm, color: colors.secondary }}>
          {wireCount} wire{wireCount !== 1 ? 's' : ''}
        </span>
      )}

      {gitBranch && (
        <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono, display: 'flex', alignItems: 'center', gap: '4px' }}>
          {gitBranch}
          {gitDirty && (
            <span style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: colors.primary,
            }} />
          )}
        </span>
      )}

      <div style={{ flex: 1 }} />

      <RecordButton />

      <span
        onClick={() => {
          useCanvasStore.getState().setTransform({ ...transform, scale: 1 });
        }}
        title="Click to reset zoom to 100%"
        style={{
          ...typography.labelSm,
          color: colors.secondary,
          fontFamily: fonts.mono,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--tx-on-surface)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--tx-secondary)'; }}
      >
        {zoomPercent}
      </span>

      <ThemePicker />

      <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono }}>
        {hours}:{mins}:{secs}
      </span>
    </div>
  );
}

function RecordButton() {
  const isRecording = useRecordingStore(s => s.isRecording);
  const eventCount = useRecordingStore(s => s.events.length);

  const handleClick = () => {
    const store = useRecordingStore.getState();
    if (store.isRecording) {
      const events = store.stopRecording();
      // Save recording to localStorage for replay
      try {
        localStorage.setItem('tx-last-recording', JSON.stringify(events));
      } catch { /* storage full */ }
    } else {
      store.startRecording();
    }
  };

  return (
    <button
      onClick={handleClick}
      title={isRecording ? `Recording (${eventCount} events) — click to stop` : 'Start recording session'}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '2px 8px',
        background: isRecording ? 'rgba(248,113,113,0.15)' : 'transparent',
        border: `1px solid ${isRecording ? 'rgba(248,113,113,0.3)' : colors.outlineGhost}`,
        borderRadius: radius.full,
        cursor: 'pointer',
        ...typography.labelSm,
        fontFamily: fonts.mono,
        color: isRecording ? colors.red : colors.secondary,
        transition: `all ${motion.hover}`,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isRecording ? colors.red : colors.secondary,
        animation: isRecording ? 'pulse 1.5s ease-in-out infinite' : 'none',
      }} />
      {isRecording ? 'REC' : 'Rec'}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </button>
  );
}
