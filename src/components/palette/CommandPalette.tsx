import { useState, useRef, useEffect, useMemo } from 'react';
import Fuse from 'fuse.js';
import { motion } from 'framer-motion';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTemplateStore, type TileTemplate } from '@/stores/templateStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useClipboardStore } from '@/stores/clipboardStore';
import { ptyWrite } from '@/utils/ipc';
import { colors, glass, radius, spacing, typography, fonts, motion as motionTokens, alpha } from '@/design/tokens';
import { saveSnapshot, listSnapshots, loadSnapshot } from '@/utils/ipc';
import { save as dialogSave, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { TileType } from '@/types';

interface CommandPaletteProps {
  onClose: () => void;
  onAddTile: (type: TileType) => void;
  onAddFromTemplate: (template: TileTemplate) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette({ onClose, onAddFromTemplate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const projects = useProjectStore(s => s.projects);
  const templates = useTemplateStore(s => s.templates);
  const activeProject = useCanvasStore(s => s.activeProject);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load snapshots on open
  useEffect(() => {
    if (activeProject) {
      listSnapshots(activeProject).then(setSnapshots).catch(() => {});
    }
  }, [activeProject]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    // Templates
    for (const t of templates) {
      result.push({
        id: `tmpl-${t.id}`,
        label: `${t.name}${t.description ? ` — ${t.description}` : ''}`,
        category: 'template',
        action: () => onAddFromTemplate(t),
      });
    }

    // Project switching
    for (const p of projects) {
      result.push({
        id: `project-${p.id}`,
        label: `Switch to ${p.name}`,
        category: 'project',
        action: () => useProjectStore.getState().setActive(p.id),
      });
    }

    // Snapshot: Save
    result.push({
      id: 'snapshot-save',
      label: 'Save Workspace Snapshot',
      category: 'workspace',
      action: async () => {
        const name = prompt('Snapshot name:');
        if (!name) return;
        const snapshot = useCanvasStore.getState().saveSnapshot(name);
        await saveSnapshot(activeProject, name, snapshot).catch(console.error);
        useTimelineStore.getState().recordEvent('snapshot-saved', `Saved snapshot: ${name}`);
      },
    });

    // Snapshot: Load
    for (const snap of snapshots) {
      result.push({
        id: `snapshot-load-${snap}`,
        label: `Load Snapshot: ${snap}`,
        category: 'workspace',
        action: async () => {
          const data = await loadSnapshot(activeProject, snap);
          if (data) useCanvasStore.getState().loadSnapshot(data);
        },
      });
    }

    // Commands
    result.push({
      id: 'cmd-focus',
      label: 'Toggle Focus Mode',
      category: 'command',
      shortcut: 'Ctrl+Enter',
      action: () => {
        const store = useCanvasStore.getState();
        if (store.focusModeActive) store.exitFocusMode();
        else if (store.focusedTile) store.enterFocusMode([store.focusedTile]);
      },
    });

    result.push({
      id: 'cmd-reset-zoom',
      label: 'Reset Canvas Zoom',
      category: 'command',
      action: () => useCanvasStore.getState().resetTransform(),
    });

    // Bookmarks: Save
    result.push({
      id: 'cmd-bookmark-save',
      label: 'Save Canvas Bookmark',
      category: 'navigate',
      shortcut: 'Ctrl+Shift+B',
      action: () => {
        const name = prompt('Bookmark name:');
        if (name) useCanvasStore.getState().addBookmark(name);
      },
    });

    // Bookmarks: Jump
    const bookmarks = useCanvasStore.getState().currentBookmarks();
    for (let i = 0; i < bookmarks.length; i++) {
      const bm = bookmarks[i];
      result.push({
        id: `bookmark-${i}`,
        label: `Jump to: ${bm.name}`,
        category: 'navigate',
        shortcut: i < 9 ? `Ctrl+${i + 1}` : undefined,
        action: () => useCanvasStore.getState().jumpToBookmark(i),
      });
    }

    // Group selected tiles
    result.push({
      id: 'cmd-group-tiles',
      label: 'Group Selected Tiles',
      category: 'command',
      shortcut: 'Ctrl+G',
      action: () => {
        const store = useCanvasStore.getState();
        if (store.selectedTiles.length >= 2) {
          const label = prompt('Group name:') || 'Group';
          store.groupTiles(store.selectedTiles, label);
        }
      },
    });

    // ─── Feature 4: Export Workspace ────────────────────
    result.push({
      id: 'cmd-export-workspace',
      label: 'Export Workspace',
      category: 'workspace',
      action: async () => {
        try {
          const store = useCanvasStore.getState();
          const pid = store.activeProject;
          if (!pid) return;
          const payload = {
            version: 1,
            projectId: pid,
            tiles: store.tiles[pid] ?? [],
            wires: store.wires[pid] ?? [],
            transform: store.transforms[pid] ?? { x: 0, y: 0, scale: 1 },
            exportedAt: new Date().toISOString(),
          };
          const filePath = await dialogSave({
            title: 'Export Workspace',
            defaultPath: `workspace-${pid}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
          if (!filePath) return;
          await writeTextFile(filePath, JSON.stringify(payload, null, 2));
          useTimelineStore.getState().recordEvent('snapshot-saved', `Exported workspace to file`);
        } catch (e) {
          console.error('Export failed:', e);
        }
      },
    });

    // ─── Feature 4: Import Workspace ────────────────────
    result.push({
      id: 'cmd-import-workspace',
      label: 'Import Workspace',
      category: 'workspace',
      action: async () => {
        try {
          const filePath = await dialogOpen({
            title: 'Import Workspace',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            multiple: false,
          });
          if (!filePath) return;
          const raw = await readTextFile(filePath as string);
          const data = JSON.parse(raw);
          if (!data || typeof data.version !== 'number' || !Array.isArray(data.tiles)) {
            alert('Invalid workspace file.');
            return;
          }
          useCanvasStore.getState().loadSnapshot({
            name: '__import__',
            tiles: data.tiles,
            wires: data.wires ?? [],
            transform: data.transform ?? { x: 0, y: 0, scale: 1 },
            createdAt: data.exportedAt ?? new Date().toISOString(),
          });
          useTimelineStore.getState().recordEvent('snapshot-saved', `Imported workspace from file`);
        } catch (e) {
          console.error('Import failed:', e);
        }
      },
    });

    // ─── Plugin: Register ──────────────────────────────
    result.push({
      id: 'cmd-register-plugin',
      label: 'Register Plugin',
      category: 'command',
      action: async () => {
        const { usePluginStore } = await import('@/stores/pluginStore');
        const url = prompt('Plugin manifest URL or paste JSON:');
        if (!url) return;
        try {
          let manifest;
          if (url.startsWith('{')) {
            manifest = JSON.parse(url);
          } else {
            const res = await fetch(url);
            manifest = await res.json();
          }
          if (!manifest.id || !manifest.name || !manifest.tileType) {
            alert('Invalid plugin manifest: must have id, name, and tileType');
            return;
          }
          usePluginStore.getState().registerPlugin(manifest, manifest.entryUrl);
        } catch (e) {
          alert('Failed to load plugin: ' + String(e));
        }
      },
    });

    // Toggle timeline
    result.push({
      id: 'cmd-timeline',
      label: 'Toggle Session Timeline',
      category: 'command',
      shortcut: 'Ctrl+J',
      action: () => useTimelineStore.getState().toggle(),
    });

    // Clipboard history
    const clipEntries = useClipboardStore.getState().entries.slice(0, 10);
    for (let i = 0; i < clipEntries.length; i++) {
      const entry = clipEntries[i];
      const preview = entry.content.slice(0, 60).replace(/\n/g, ' ');
      result.push({
        id: `clip-${entry.id}`,
        label: `Paste: ${preview}${entry.content.length > 60 ? '...' : ''}`,
        category: 'clipboard',
        action: () => {
          // Write to focused tile's PTY if it has one
          const store = useCanvasStore.getState();
          const pid = store.activeProject;
          const focused = store.focusedTile;
          if (!focused) { navigator.clipboard.writeText(entry.content); return; }
          const tile = (store.tiles[pid] || []).find(t => t.id === focused);
          if (tile && 'ptyId' in tile && (tile as { ptyId?: string }).ptyId) {
            ptyWrite((tile as { ptyId: string }).ptyId, entry.content).catch(() => {});
          } else {
            navigator.clipboard.writeText(entry.content);
          }
        },
      });
    }

    return result;
  }, [projects, templates, snapshots, activeProject, onAddFromTemplate]);

  const fuse = useMemo(() => new Fuse(items, {
    keys: ['label', 'category'],
    threshold: 0.4,
  }), [items]);

  const results = query ? fuse.search(query).map(r => r.item) : items;

  useEffect(() => { setSelectedIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      results[selectedIndex].action();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', justifyContent: 'center', paddingTop: '18vh',
        background: alpha(colors.bg, 50), backdropFilter: 'blur(4px)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxHeight: 420, ...glass,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          alignSelf: 'flex-start',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          style={{
            height: 48, width: '100%', background: 'transparent',
            border: 'none', borderBottom: `1px solid ${colors.outlineGhost}`,
            color: colors.onSurface, fontFamily: fonts.body, fontSize: '1rem',
            padding: `0 ${spacing.lg}`, outline: 'none', flexShrink: 0,
          }}
        />

        <div style={{ flex: 1, overflowY: 'auto', padding: spacing.xs }}>
          {results.map((item, i) => (
            <button
              key={item.id}
              onClick={() => { item.action(); onClose(); }}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: spacing.sm,
                width: '100%', height: 36, padding: `0 ${spacing.sm}`,
                background: i === selectedIndex ? colors.surfaceHigh : 'transparent',
                border: 'none', borderRadius: radius.sm,
                color: colors.onSurfaceVariant, cursor: 'pointer',
                transition: `background ${motionTokens.hover}`, textAlign: 'left',
              }}
            >
              <span style={{
                ...typography.labelSm,
                color: colors.primary,
                background: 'var(--tx-glow-strong)',
                padding: '1px 6px', borderRadius: radius.sm,
                fontSize: '0.5625rem', textTransform: 'uppercase',
              }}>
                {item.category}
              </span>

              <span style={{ ...typography.labelMd, flex: 1 }}>
                {item.label}
              </span>

              {item.shortcut && (
                <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono }}>
                  {item.shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
