import { useState, useEffect, useCallback } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { gitFilesStatus, gitShowHeadFile, readFileText, type GitFileStatus } from '@/utils/ipc';
import { colors, fonts, spacing, typography, radius, alpha, motion } from '@/design/tokens';
import type { DiffTile as DiffTileType } from '@/types';

interface DiffTileProps {
  tile: DiffTileType;
}

type DiffMode = 'git' | 'compare' | 'paste';

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    rs: 'rust', py: 'python', go: 'go', toml: 'toml', yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', xml: 'xml',
    svg: 'xml', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', java: 'java',
  };
  return map[ext] || 'plaintext';
}

function basename(p: string): string {
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  return p.split(sep).pop() || p;
}

const STATUS_COLOR: Record<string, string> = {
  M: '#facc15', A: '#22c55e', D: '#ef4444', '??': '#94a3b8',
  R: '#a855f7', C: '#a855f7',
};

const STATUS_LABEL: Record<string, string> = {
  M: 'modified', A: 'added', D: 'deleted', '??': 'untracked',
  R: 'renamed', C: 'copied',
};

export function DiffTile({ tile }: DiffTileProps) {
  const mode: DiffMode = tile.mode ?? 'git';
  const projects = useProjectStore(s => s.projects);
  const activeProject = useCanvasStore(s => s.activeProject);
  const project = projects.find(p => p.id === activeProject);
  const repoPath = tile.repoPath || project?.cwd || '~';

  const update = useCallback((patch: Partial<DiffTileType>) => {
    useCanvasStore.getState().updateTile(tile.id, patch);
  }, [tile.id]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ModeBar mode={mode} onChange={(m) => update({ mode: m })} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {mode === 'git' && (
          <GitMode tile={tile} repoPath={repoPath} update={update} />
        )}
        {mode === 'compare' && (
          <CompareMode tile={tile} update={update} />
        )}
        {mode === 'paste' && (
          <PasteMode tile={tile} update={update} />
        )}
      </div>
    </div>
  );
}

function ModeBar({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  const tabs: { id: DiffMode; label: string; hint: string }[] = [
    { id: 'git', label: 'Git changes', hint: 'Working tree vs HEAD' },
    { id: 'compare', label: 'Compare files', hint: 'Pick two files' },
    { id: 'paste', label: 'Paste', hint: 'Compare two snippets' },
  ];
  return (
    <div style={{
      display: 'flex',
      gap: 2,
      padding: `${spacing.xs} ${spacing.sm}`,
      borderBottom: `1px solid ${colors.outlineVariant}`,
      background: colors.surfaceLowest,
      flexShrink: 0,
    }}>
      {tabs.map(t => {
        const active = mode === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={t.hint}
            style={{
              padding: '4px 10px',
              borderRadius: radius.sm,
              border: 'none',
              background: active ? alpha(colors.primary, 14) : 'transparent',
              color: active ? colors.primary : colors.onSurfaceVariant,
              ...typography.labelSm,
              fontSize: '0.6875rem',
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
              transition: `all ${motion.hover}`,
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 8); }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Git mode ─────────────────────────────────────────────────────
function GitMode({ tile, repoPath, update }: {
  tile: DiffTileType;
  repoPath: string;
  update: (patch: Partial<DiffTileType>) => void;
}) {
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [original, setOriginal] = useState<string>('');
  const [modified, setModified] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const target = tile.gitTarget || '';

  const refresh = useCallback(() => {
    setListLoading(true);
    setListError(null);
    gitFilesStatus(repoPath)
      .then(setFiles)
      .catch(err => setListError(String(err)))
      .finally(() => setListLoading(false));
  }, [repoPath]);

  useEffect(() => { refresh(); }, [refresh]);

  // Load diff content when a file is selected
  useEffect(() => {
    if (!target) {
      setOriginal(''); setModified(''); setDiffError(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    Promise.all([
      gitShowHeadFile(repoPath, target).catch(() => ''),
      readFileText(`${repoPath}/${target}`).catch(() => ''),
    ])
      .then(([head, working]) => {
        setOriginal(head);
        setModified(working);
      })
      .catch(err => setDiffError(String(err)))
      .finally(() => setDiffLoading(false));
  }, [repoPath, target]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Left: file picker */}
      <div style={{
        width: 220,
        flexShrink: 0,
        borderRight: `1px solid ${colors.outlineVariant}`,
        display: 'flex', flexDirection: 'column',
        background: colors.surfaceLowest,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${spacing.xs} ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <span style={{
            ...typography.labelSm, fontSize: '0.5625rem',
            color: colors.secondary,
            textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
          }}>
            Changes ({files.length})
          </span>
          <button
            onClick={refresh}
            title="Refresh"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: colors.secondary, fontSize: 12, padding: 0,
            }}
          >
            ↻
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {listLoading && <SidebarHint>Loading…</SidebarHint>}
          {!listLoading && listError && <SidebarHint error>{listError}</SidebarHint>}
          {!listLoading && !listError && files.length === 0 && (
            <SidebarHint>No changes — working tree is clean.</SidebarHint>
          )}
          {files.map(f => {
            const isActive = f.path === target;
            const code = f.status.trim() || '??';
            return (
              <button
                key={f.path}
                onClick={() => update({ gitTarget: f.path })}
                title={`${STATUS_LABEL[code] || code} — click to diff`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', padding: '5px 8px',
                  background: isActive ? alpha(colors.primary, 14) : 'transparent',
                  border: 'none', borderRadius: 0,
                  color: isActive ? colors.primary : colors.onSurfaceVariant,
                  cursor: 'pointer', textAlign: 'left',
                  fontFamily: fonts.mono, fontSize: '0.6875rem',
                  transition: `background ${motion.hover}`,
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 6); }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  width: 14, fontWeight: 700,
                  color: STATUS_COLOR[code] || colors.secondary,
                  flexShrink: 0,
                }}>
                  {code === '??' ? '+' : code}
                </span>
                <span style={{
                  flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  direction: 'rtl', textAlign: 'left',
                }}>
                  {f.path}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: diff editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!target && (
          <EmptyState
            icon="diff"
            title="Pick a file"
            hint="Select a changed file from the left to see what changed since HEAD."
          />
        )}
        {target && diffLoading && <CenterMessage>Loading diff…</CenterMessage>}
        {target && diffError && <CenterMessage error>{diffError}</CenterMessage>}
        {target && !diffLoading && !diffError && (
          <DiffPane
            language={detectLanguage(target)}
            original={original}
            modified={modified}
            originalLabel="HEAD"
            modifiedLabel="working tree"
            fileLabel={target}
          />
        )}
      </div>
    </div>
  );
}

// ─── Compare mode ─────────────────────────────────────────────────
function CompareMode({ tile, update }: {
  tile: DiffTileType;
  update: (patch: Partial<DiffTileType>) => void;
}) {
  const left = tile.compareLeft || '';
  const right = tile.compareRight || '';
  const [original, setOriginal] = useState('');
  const [modified, setModified] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!left && !right) { setOriginal(''); setModified(''); return; }
    setLoading(true); setError(null);
    Promise.all([
      left ? readFileText(left).catch(e => `[failed to read: ${e}]`) : Promise.resolve(''),
      right ? readFileText(right).catch(e => `[failed to read: ${e}]`) : Promise.resolve(''),
    ])
      .then(([a, b]) => { setOriginal(a); setModified(b); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [left, right]);

  const pickFile = async (side: 'left' | 'right') => {
    const selected = await openDialog({ multiple: false, directory: false });
    if (typeof selected !== 'string') return;
    update(side === 'left' ? { compareLeft: selected } : { compareRight: selected });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', gap: spacing.sm,
        padding: `${spacing.sm} ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineVariant}`,
        background: colors.surfaceLowest,
        flexShrink: 0,
      }}>
        <FilePickerInput label="Original" value={left} onPick={() => pickFile('left')} onClear={() => update({ compareLeft: '' })} />
        <FilePickerInput label="Modified" value={right} onPick={() => pickFile('right')} onClear={() => update({ compareRight: '' })} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {!left && !right && (
          <EmptyState icon="files" title="Pick two files" hint="Choose an original and a modified file to compare them side by side." />
        )}
        {(left || right) && loading && <CenterMessage>Loading…</CenterMessage>}
        {(left || right) && error && <CenterMessage error>{error}</CenterMessage>}
        {(left || right) && !loading && !error && (
          <DiffPane
            language={detectLanguage(right || left)}
            original={original}
            modified={modified}
            originalLabel={basename(left) || 'original'}
            modifiedLabel={basename(right) || 'modified'}
            fileLabel=""
          />
        )}
      </div>
    </div>
  );
}

function FilePickerInput({ label, value, onPick, onClear }: {
  label: string;
  value: string;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{
        ...typography.labelSm, fontSize: '0.5625rem',
        color: colors.secondary,
        textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
      }}>
        {label}
      </span>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: colors.surfaceLow,
        border: `1px solid ${colors.outlineGhost}`,
        borderRadius: radius.sm,
        padding: '2px 4px 2px 8px',
      }}>
        <span style={{
          flex: 1, minWidth: 0,
          ...typography.labelSm, fontSize: '0.6875rem',
          color: value ? colors.onSurface : colors.secondary,
          fontFamily: fonts.mono,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          direction: value ? 'rtl' : 'ltr', textAlign: 'left',
        }}>
          {value || 'No file selected'}
        </span>
        {value && (
          <button onClick={onClear} title="Clear" style={smallIconBtn}>✕</button>
        )}
        <button onClick={onPick} title="Pick file" style={pickBtn}>Browse…</button>
      </div>
    </div>
  );
}

const smallIconBtn: React.CSSProperties = {
  width: 20, height: 20, padding: 0,
  background: 'none', border: 'none', borderRadius: radius.sm,
  color: colors.secondary, cursor: 'pointer',
  fontSize: 11, lineHeight: 1,
};

const pickBtn: React.CSSProperties = {
  ...typography.labelSm, fontSize: '0.625rem', fontWeight: 600,
  padding: '3px 8px', borderRadius: radius.sm,
  background: alpha(colors.primary, 14),
  border: `1px solid ${alpha(colors.primary, 30)}`,
  color: colors.primary, cursor: 'pointer',
  fontFamily: fonts.mono,
};

// ─── Paste mode ───────────────────────────────────────────────────
function PasteMode({ tile, update }: {
  tile: DiffTileType;
  update: (patch: Partial<DiffTileType>) => void;
}) {
  const original = tile.pasteOriginal || '';
  const modified = tile.pasteModified || '';
  const [showEditor, setShowEditor] = useState(!!(original || modified));

  if (!showEditor && !original && !modified) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', gap: spacing.sm,
        padding: spacing.md,
      }}>
        <div style={{ display: 'flex', gap: spacing.sm, flex: 1, minHeight: 0 }}>
          <PasteBox label="Original" value={original} onChange={v => update({ pasteOriginal: v })} />
          <PasteBox label="Modified" value={modified} onChange={v => update({ pasteModified: v })} />
        </div>
        <button
          onClick={() => setShowEditor(true)}
          disabled={!original && !modified}
          style={{
            alignSelf: 'flex-end',
            padding: '6px 14px',
            borderRadius: radius.sm,
            background: (original || modified) ? colors.primary : alpha(colors.secondary, 20),
            color: (original || modified) ? colors.bg : colors.secondary,
            border: 'none',
            cursor: (original || modified) ? 'pointer' : 'not-allowed',
            ...typography.labelSm, fontSize: '0.75rem', fontWeight: 600,
          }}
        >
          Compare →
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${spacing.xs} ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineVariant}`,
        background: colors.surfaceLowest,
        flexShrink: 0,
      }}>
        <span style={{ ...typography.labelSm, fontSize: '0.6875rem', color: colors.secondary }}>
          Pasted snippets
        </span>
        <button
          onClick={() => setShowEditor(false)}
          style={{
            ...typography.labelSm, fontSize: '0.625rem',
            padding: '3px 8px', borderRadius: radius.sm,
            background: 'none', border: `1px solid ${colors.outlineGhost}`,
            color: colors.onSurfaceVariant, cursor: 'pointer',
          }}
        >
          ← Edit
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffPane
          language="plaintext"
          original={original}
          modified={modified}
          originalLabel="original"
          modifiedLabel="modified"
          fileLabel=""
        />
      </div>
    </div>
  );
}

function PasteBox({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <span style={{
        ...typography.labelSm, fontSize: '0.5625rem',
        color: colors.secondary,
        textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
      }}>
        {label}
      </span>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`Paste ${label.toLowerCase()} text…`}
        spellCheck={false}
        onKeyDown={e => e.stopPropagation()}
        style={{
          flex: 1, minHeight: 0,
          padding: spacing.sm,
          background: colors.surfaceLow,
          border: `1px solid ${colors.outlineGhost}`,
          borderRadius: radius.sm,
          color: colors.onSurface,
          fontFamily: fonts.mono, fontSize: '0.75rem',
          outline: 'none',
          resize: 'none',
        }}
      />
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────
function DiffPane({ language, original, modified, originalLabel, modifiedLabel, fileLabel }: {
  language: string;
  original: string;
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  fileLabel: string;
}) {
  const handleEditorMount: DiffOnMount = useCallback((editor) => {
    const m = editor.getModifiedEditor();
    const o = editor.getOriginalEditor();
    m.onKeyDown((e: { stopPropagation: () => void }) => e.stopPropagation());
    o.onKeyDown((e: { stopPropagation: () => void }) => e.stopPropagation());
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.md,
        padding: `2px ${spacing.sm}`,
        background: colors.surfaceLowest,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        ...typography.labelSm, fontSize: '0.5625rem',
        color: colors.secondary,
        flexShrink: 0,
      }}>
        <span style={{ flex: 1, color: '#ef4444' }}>−  {originalLabel}</span>
        <span style={{ flex: 1, color: '#22c55e' }}>+  {modifiedLabel}</span>
        {fileLabel && (
          <span style={{ marginLeft: spacing.md, fontFamily: fonts.mono }}>{fileLabel}</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffEditor
          theme="vs-dark"
          language={language}
          original={original}
          modified={modified}
          onMount={handleEditorMount}
          options={{
            fontSize: 13,
            fontFamily: `'JetBrains Mono', monospace`,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            padding: { top: 8 },
          }}
          loading={<CenterMessage>Loading editor…</CenterMessage>}
        />
      </div>
    </div>
  );
}

function CenterMessage({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: spacing.md,
      color: error ? colors.red : colors.secondary,
      ...typography.labelSm,
      textAlign: 'center', wordBreak: 'break-word',
    }}>
      {children}
    </div>
  );
}

function SidebarHint({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div style={{
      padding: spacing.sm,
      ...typography.labelSm, fontSize: '0.6875rem',
      color: error ? colors.red : colors.secondary,
      fontStyle: 'italic',
    }}>
      {children}
    </div>
  );
}

function EmptyState({ icon, title, hint }: { icon: 'diff' | 'files'; title: string; hint: string }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: spacing.sm,
      padding: spacing.lg,
      color: colors.secondary, textAlign: 'center',
    }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {icon === 'diff' ? (
          <path d="M12 3v18M3 12h18M8 8l-5 4 5 4M16 8l5 4-5 4" />
        ) : (
          <>
            <path d="M14 3h-9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9" />
            <path d="M19 5h-4M19 9h-4M19 13h-4M21 17l-2 2-2-2M19 19V5" />
          </>
        )}
      </svg>
      <span style={{ ...typography.labelMd }}>{title}</span>
      <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant, maxWidth: 320 }}>
        {hint}
      </span>
    </div>
  );
}
