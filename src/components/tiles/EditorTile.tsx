import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { readFileText, writeFileText, getFileSize } from '@/utils/ipc';
import { detectLanguage } from '@/utils/detectLanguage';
import { friendlyFsError } from '@/utils/constants';
import { colors, spacing, typography } from '@/design/tokens';
import type { EditorTile as EditorTileType } from '@/types';

// Monaco uses DOM divs for text rendering (not canvas), so CSS `zoom`
// on the outer canvas layer re-rasterizes its text natively — no inner
// fontSize bump needed. Minimap is disabled, which is the only canvas
// layer that would stretch-blur under outer zoom.

// Tiered load strategy — Monaco's sync tokenizer pass costs roughly
// 100-200 ms per MB on modern hardware, and semantic/bracket features add
// more. We match thresholds to perceived pain thresholds:
//   < 512 KB  → normal Monaco (no-op)
//   512 KB-5 MB → auto-optimized (silently disable heavy decorations)
//   5 MB-20 MB → prompt the user; on confirm load plain-text mode
//   > 20 MB   → prompt strongly (near Monaco's own internal ceiling)
// The 10 MB Rust read cap means we never actually see >10 MB in practice,
// but the 20 MB tier is kept for future-proofing.
const MEDIUM_FILE_THRESHOLD = 512 * 1024;       // 512 KB
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;   // 5 MB
const HUGE_FILE_THRESHOLD = 20 * 1024 * 1024;   // 20 MB

type LoadMode = 'normal' | 'optimized' | 'plaintext';

interface EditorTileProps {
  tile: EditorTileType;
}

export function EditorTile({ tile }: EditorTileProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<LoadMode>('normal');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(tile.filePath);

  // Load file content when filePath changes
  useEffect(() => {
    filePathRef.current = tile.filePath;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (!tile.filePath) {
      setContent(null);
      setLoading(false);
      setError(null);
      setLoadMode('normal');
      return;
    }

    setLoading(true);
    setError(null);
    setLoadMode('normal');

    // Check size BEFORE reading. Reading a 50 MB log into memory then
    // deciding to cancel is too late — we want to fail cheap.
    const load = async () => {
      try {
        const size = await getFileSize(tile.filePath);
        if (filePathRef.current !== tile.filePath) return;

        let mode: LoadMode = 'normal';
        if (size > HUGE_FILE_THRESHOLD) {
          const mb = (size / (1024 * 1024)).toFixed(1);
          const ok = window.confirm(
            `This file is ${mb} MB — very large. Monaco will drop syntax highlighting, folding, and most features. Open anyway as plain text?\n\nOK = open plain-text, Cancel = don't open`,
          );
          if (!ok) { setContent(null); setLoading(false); return; }
          mode = 'plaintext';
        } else if (size > LARGE_FILE_THRESHOLD) {
          const mb = (size / (1024 * 1024)).toFixed(1);
          const ok = window.confirm(
            `This file is ${mb} MB. Loading it with full syntax highlighting will freeze the editor for ~${Math.ceil(size / (5 * 1024 * 1024))}s. Open in plain-text mode for fast response?\n\nOK = open plain-text, Cancel = don't open`,
          );
          if (!ok) { setContent(null); setLoading(false); return; }
          mode = 'plaintext';
        } else if (size > MEDIUM_FILE_THRESHOLD) {
          // Silent middle tier — disable the expensive decorations but
          // keep syntax highlighting and folding. No prompt, just faster.
          mode = 'optimized';
        }

        const text = await readFileText(tile.filePath);
        if (filePathRef.current !== tile.filePath) return;
        setLoadMode(mode);
        setContent(text);
        setLoading(false);
      } catch (err) {
        if (filePathRef.current !== tile.filePath) return;
        setError(friendlyFsError(err));
        setLoading(false);
      }
    };
    load();
  }, [tile.filePath]);

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleChange = useCallback((value: string | undefined) => {
    if (value === undefined) return;
    setContent(value);
    const pathAtEdit = filePathRef.current;

    // Debounced auto-save (1s)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (pathAtEdit && filePathRef.current === pathAtEdit) {
        writeFileText(pathAtEdit, value).catch(console.error);
      }
    }, 1000);
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    // Prevent keyboard shortcuts from bubbling to the canvas
    editor.onKeyDown((e) => {
      e.stopPropagation();
    });
  }, []);

  // No file selected — show placeholder
  if (!tile.filePath) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: spacing.sm,
        color: colors.secondary,
      }}>
        <span style={{ ...typography.labelMd }}>Monaco Editor</span>
        <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
          Drop a file or select from file tree
        </span>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: colors.secondary, ...typography.labelSm,
      }}>
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: spacing.sm,
        padding: spacing.md,
        color: colors.secondary, ...typography.labelSm,
        textAlign: 'center',
      }}>
        <span>Failed to load file</span>
        <span style={{ color: colors.onSurfaceVariant, fontSize: '0.625rem' }}>{error}</span>
      </div>
    );
  }

  const language = loadMode === 'plaintext'
    ? 'plaintext'
    : (tile.language || detectLanguage(tile.filePath));

  // Tier the Monaco options. The 'optimized' tier disables decoration
  // work that dominates parse time on medium files; the 'plaintext' tier
  // strips folding, validation, and bracket colorization entirely.
  const isOptimized = loadMode !== 'normal';
  const isPlaintext = loadMode === 'plaintext';

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Editor
        // Intentional: vs-dark matches our always-dark (bg: #000) theme
        theme="vs-dark"
        language={language}
        value={content ?? ''}
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          fontSize: 13,
          fontFamily: `'JetBrains Mono', monospace`,
          minimap: { enabled: false },
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          padding: { top: 8 },
          automaticLayout: true,
          largeFileOptimizations: true,
          // Decoration/UI features scaled back per tier
          bracketPairColorization: { enabled: !isOptimized },
          renderValidationDecorations: isOptimized ? 'off' : 'editable',
          occurrencesHighlight: isOptimized ? 'off' : 'singleFile',
          folding: !isPlaintext,
          wordWrap: isPlaintext ? 'on' : 'off',
          ...(isPlaintext ? { guides: { indentation: false, bracketPairs: false } } : {}),
        }}
        loading={
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: colors.secondary, ...typography.labelSm,
          }}>
            Loading editor...
          </div>
        }
      />
    </div>
  );
}
