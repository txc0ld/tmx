import { useState, useEffect, useRef, useCallback } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, fonts, spacing, typography, radius } from '@/design/tokens';
import type { DiffTile as DiffTileType } from '@/types';

interface DiffTileProps {
  tile: DiffTileType;
}

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

/**
 * Reconstruct the "original" content from the modified content and the tile's hunks.
 * If hunks are present, we reverse-apply them: remove 'add' lines and restore 'remove' lines.
 * If no hunks, the original is an empty string (new file scenario).
 */
function reconstructOriginal(modified: string, hunks: DiffTileType['hunks']): string {
  if (!hunks || hunks.length === 0) return '';

  const modifiedLines = modified.split('\n');
  const originalLines: string[] = [];

  let modIdx = 0;
  let hunkIdx = 0;

  while (modIdx < modifiedLines.length || hunkIdx < hunks.length) {
    const hunk = hunks[hunkIdx];

    if (hunk && modIdx + 1 >= hunk.newStart) {
      // Process hunk lines
      for (const line of hunk.lines) {
        if (line.type === 'context') {
          originalLines.push(line.content);
          modIdx++;
        } else if (line.type === 'remove') {
          // This line exists in original but not in modified
          originalLines.push(line.content);
        } else if (line.type === 'add') {
          // This line exists in modified but not in original — skip in original, advance modified
          modIdx++;
        }
      }
      hunkIdx++;
    } else {
      // Outside any hunk — lines are identical
      originalLines.push(modifiedLines[modIdx] ?? '');
      modIdx++;
    }
  }

  return originalLines.join('\n');
}

export function DiffTile({ tile }: DiffTileProps) {
  const [modified, setModified] = useState<string | null>(null);
  const [original, setOriginal] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(tile.filePath || '');
  const filePathRef = useRef(tile.filePath);

  // Sync input when tile.filePath changes externally
  useEffect(() => {
    setInputValue(tile.filePath || '');
  }, [tile.filePath]);

  // Load file content when filePath changes
  useEffect(() => {
    filePathRef.current = tile.filePath;

    if (!tile.filePath) {
      setModified(null);
      setOriginal('');
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    readTextFile(tile.filePath)
      .then((text) => {
        if (filePathRef.current === tile.filePath) {
          setModified(text);
          setOriginal(reconstructOriginal(text, tile.hunks));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (filePathRef.current === tile.filePath) {
          setError(String(err));
          setLoading(false);
        }
      });
  }, [tile.filePath, tile.hunks]);

  const handleSubmitPath = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    useCanvasStore.getState().updateTile(tile.id, { filePath: trimmed } as Partial<DiffTileType>);
  }, [tile.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSubmitPath(inputValue);
    }
    // Prevent canvas shortcuts from firing
    e.stopPropagation();
  }, [inputValue, handleSubmitPath]);

  const handleEditorMount: DiffOnMount = useCallback((editor) => {
    // Prevent keyboard shortcuts from bubbling to the canvas
    // DiffEditor exposes two sub-editors; attach to both
    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();
    modifiedEditor.onKeyDown((e: { stopPropagation: () => void }) => {
      e.stopPropagation();
    });
    originalEditor.onKeyDown((e: { stopPropagation: () => void }) => {
      e.stopPropagation();
    });
  }, []);

  const language = tile.filePath ? detectLanguage(tile.filePath) : 'plaintext';

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* File path input bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.sm,
        padding: `${spacing.xs} ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineVariant}`,
        background: colors.surfaceLowest,
        flexShrink: 0,
      }}>
        <span style={{
          ...typography.labelSm,
          color: colors.onSurfaceVariant,
          flexShrink: 0,
        }}>
          File
        </span>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (inputValue.trim() && inputValue.trim() !== tile.filePath) handleSubmitPath(inputValue); }}
          placeholder="Enter file path and press Enter..."
          style={{
            flex: 1,
            background: colors.surfaceLow,
            color: colors.onSurface,
            border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm,
            padding: `${spacing.xs} ${spacing.sm}`,
            fontFamily: fonts.mono,
            fontSize: '0.75rem',
            outline: 'none',
          }}
        />
      </div>

      {/* Content area */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {/* Empty state */}
        {!tile.filePath && (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: spacing.sm,
            color: colors.secondary,
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18M3 12h18M8 8l-5 4 5 4M16 8l5 4-5 4" />
            </svg>
            <span style={{ ...typography.labelMd }}>Diff Viewer</span>
            <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
              Enter a file path above to view changes
            </span>
          </div>
        )}

        {/* Loading state */}
        {tile.filePath && loading && (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: colors.secondary, ...typography.labelSm,
          }}>
            Loading file...
          </div>
        )}

        {/* Error state */}
        {tile.filePath && !loading && error && (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: spacing.sm,
            padding: spacing.md,
            color: colors.secondary, ...typography.labelSm,
            textAlign: 'center',
          }}>
            <span>Failed to load file</span>
            <span style={{ color: colors.onSurfaceVariant, fontSize: '0.625rem', maxWidth: '80%', wordBreak: 'break-all' }}>
              {error}
            </span>
          </div>
        )}

        {/* Diff editor */}
        {tile.filePath && !loading && !error && modified !== null && (
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
            loading={
              <div style={{
                width: '100%', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: colors.secondary, ...typography.labelSm,
              }}>
                Loading diff editor...
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
