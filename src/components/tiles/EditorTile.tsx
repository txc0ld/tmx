import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { readFileText, writeFileText } from '@/utils/ipc';
import { colors, spacing, typography } from '@/design/tokens';
import type { EditorTile as EditorTileType } from '@/types';

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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(tile.filePath);

  // Load file content when filePath changes
  useEffect(() => {
    filePathRef.current = tile.filePath;

    if (!tile.filePath) {
      setContent(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    readFileText(tile.filePath)
      .then((text) => {
        // Only update if still the same file
        if (filePathRef.current === tile.filePath) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (filePathRef.current === tile.filePath) {
          setError(String(err));
          setLoading(false);
        }
      });
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

    // Debounced auto-save (1s)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (filePathRef.current) {
        writeFileText(filePathRef.current, value).catch(console.error);
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

  const language = tile.language || detectLanguage(tile.filePath);

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
