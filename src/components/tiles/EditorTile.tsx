import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { readFileText, writeFileText, getFileSize } from '@/utils/ipc';
import { colors, spacing, typography } from '@/design/tokens';
import type { EditorTile as EditorTileType } from '@/types';

// Files larger than this threshold prompt the user before loading into
// Monaco. Monaco parses the entire source synchronously for syntax
// highlighting — above a few MB, opening freezes the UI for seconds.
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2 MB

interface EditorTileProps {
  tile: EditorTileType;
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

export function EditorTile({ tile }: EditorTileProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plainTextMode, setPlainTextMode] = useState(false);
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
      setPlainTextMode(false);
      return;
    }

    setLoading(true);
    setError(null);
    setPlainTextMode(false);

    // Check size BEFORE reading. Reading a 50 MB log into memory then
    // deciding to cancel is too late — we want to fail cheap.
    const load = async () => {
      try {
        const size = await getFileSize(tile.filePath);
        if (filePathRef.current !== tile.filePath) return;
        let goPlain = false;
        if (size > LARGE_FILE_THRESHOLD) {
          const mb = (size / (1024 * 1024)).toFixed(1);
          const ok = window.confirm(
            `This file is ${mb} MB. Loading large files freezes the editor while Monaco parses. Open in plain-text mode (no syntax highlighting) for better performance?\n\nOK = plain text, Cancel = don't open`,
          );
          if (!ok) {
            setContent(null);
            setLoading(false);
            return;
          }
          goPlain = true;
        }
        const text = await readFileText(tile.filePath);
        if (filePathRef.current !== tile.filePath) return;
        setPlainTextMode(goPlain);
        setContent(text);
        setLoading(false);
      } catch (err) {
        if (filePathRef.current !== tile.filePath) return;
        setError(String(err));
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

  const language = plainTextMode ? 'plaintext' : (tile.language || detectLanguage(tile.filePath));

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
