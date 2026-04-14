import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, radius, spacing, typography, fonts, motion, glass, alpha } from '@/design/tokens';
import type { Tile, NoteTile, TodoTile, EditorTile, AgentTile, TerminalTile } from '@/types';

const EMPTY_TILES: Tile[] = [];

interface SearchResult {
  tileId: string;
  tileType: string;
  tileTitle: string;
  matchField: string;
  preview: string;
}

function searchTile(tile: Tile, query: string, wireData: Record<string, string>): SearchResult[] {
  const q = query.toLowerCase();
  const results: SearchResult[] = [];
  const title = tile.title || tile.type;

  // Search title
  if (title.toLowerCase().includes(q)) {
    results.push({ tileId: tile.id, tileType: tile.type, tileTitle: title, matchField: 'title', preview: title });
  }

  switch (tile.type) {
    case 'note': {
      const note = tile as NoteTile;
      if (note.content?.toLowerCase().includes(q)) {
        const idx = note.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 30);
        const preview = note.content.slice(start, idx + query.length + 30);
        results.push({ tileId: tile.id, tileType: 'note', tileTitle: title, matchField: 'content', preview });
      }
      break;
    }
    case 'todo': {
      const todo = tile as TodoTile;
      for (const item of (todo.items ?? [])) {
        if (item.text.toLowerCase().includes(q)) {
          results.push({ tileId: tile.id, tileType: 'todo', tileTitle: title, matchField: 'todo item', preview: item.text });
        }
      }
      break;
    }
    case 'editor': {
      const editor = tile as EditorTile;
      if (editor.filePath?.toLowerCase().includes(q)) {
        results.push({ tileId: tile.id, tileType: 'editor', tileTitle: title, matchField: 'file path', preview: editor.filePath });
      }
      break;
    }
    case 'terminal':
    case 'agent':
    case 'runner': {
      // Search wireData (terminal output)
      const ptyId = (tile as TerminalTile | AgentTile).ptyId;
      if (ptyId) {
        const output = wireData[ptyId] || '';
        if (output.toLowerCase().includes(q)) {
          const idx = output.toLowerCase().lastIndexOf(q);
          const start = Math.max(0, idx - 30);
          const preview = output.slice(start, idx + query.length + 30).replace(/\n/g, ' ');
          results.push({ tileId: tile.id, tileType: tile.type, tileTitle: title, matchField: 'output', preview });
        }
      }
      break;
    }
  }

  return results;
}

interface SearchOverlayProps {
  onClose: () => void;
}

export function SearchOverlay({ onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const tiles = useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY_TILES);
  const wireData = useCanvasStore(s => s.wireData);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo<SearchResult[]>(() => {
    if (query.length < 2) return [];
    const all: SearchResult[] = [];
    for (const tile of tiles) {
      all.push(...searchTile(tile, query, wireData));
    }
    return all.slice(0, 50);
  }, [query, tiles, wireData]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  const navigateToTile = useCallback((tileId: string) => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const tile = (store.tiles[pid] || []).find(t => t.id === tileId);
    if (!tile) return;

    // Center viewport on the tile
    const containerWidth = window.innerWidth;
    const containerHeight = window.innerHeight;
    const scale = (store.transforms[pid] || { scale: 1 }).scale;
    store.setTransform({
      x: containerWidth / 2 - (tile.x + tile.w / 2) * scale,
      y: containerHeight / 2 - (tile.y + tile.h / 2) * scale,
      scale,
    });
    store.bringToFront(tileId);
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      navigateToTile(results[selectedIndex].tileId);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [results, selectedIndex, navigateToTile, onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', justifyContent: 'center', paddingTop: '15vh',
        background: alpha(colors.bg, 50), backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 520, maxHeight: 440, ...glass,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          alignSelf: 'flex-start',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.sm,
          padding: `0 ${spacing.md}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
        }}>
          <span style={{ color: colors.secondary, fontSize: '0.875rem' }}>&#128269;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search across tiles..."
            style={{
              height: 44, flex: 1, background: 'transparent',
              border: 'none', color: colors.onSurface,
              fontFamily: fonts.body, fontSize: '0.9375rem',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: spacing.xs }}>
          {query.length >= 2 && results.length === 0 && (
            <div style={{
              padding: spacing.lg, textAlign: 'center',
              color: colors.secondary, ...typography.labelSm,
            }}>
              No matches found
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.tileId}-${r.matchField}-${i}`}
              onClick={() => navigateToTile(r.tileId)}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                width: '100%', padding: `6px ${spacing.sm}`,
                background: i === selectedIndex ? colors.surfaceHigh : 'transparent',
                border: 'none', borderRadius: radius.sm,
                cursor: 'pointer', textAlign: 'left',
                transition: `background ${motion.hover}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
                <span style={{
                  ...typography.labelSm, fontSize: '0.5625rem',
                  color: colors.primary, background: alpha(colors.primary, 10),
                  padding: '1px 5px', borderRadius: radius.sm,
                  textTransform: 'uppercase',
                }}>
                  {r.tileType}
                </span>
                <span style={{ ...typography.labelMd, color: colors.onSurface }}>
                  {r.tileTitle}
                </span>
                <span style={{ ...typography.labelSm, color: colors.secondary, marginLeft: 'auto' }}>
                  {r.matchField}
                </span>
              </div>
              <div style={{
                ...typography.labelSm, color: colors.onSurfaceVariant,
                fontFamily: fonts.mono, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {r.preview}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
