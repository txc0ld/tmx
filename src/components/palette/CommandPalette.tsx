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
import { readFileText, writeFileText } from '@/utils/ipc';
import { validateWorkspaceImport, WorkspaceImportError } from '@/utils/workspaceImport';
import { screenToCanvas } from '@/utils/layout';
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
          await writeFileText(filePath, JSON.stringify(payload, null, 2));
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
          const raw = await readFileText(filePath as string);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            alert('Workspace file is not valid JSON.');
            return;
          }
          let validated;
          try {
            validated = validateWorkspaceImport(parsed);
          } catch (err) {
            const msg = err instanceof WorkspaceImportError ? err.message : 'Invalid workspace file';
            alert(`Import rejected: ${msg}`);
            return;
          }
          const exportedAt = typeof (parsed as { exportedAt?: unknown }).exportedAt === 'string'
            ? (parsed as { exportedAt: string }).exportedAt
            : new Date().toISOString();
          useCanvasStore.getState().loadSnapshot({
            name: '__import__',
            tiles: validated.tiles,
            wires: validated.wires,
            transform: validated.transform,
            createdAt: exportedAt,
          });
          useTimelineStore.getState().recordEvent('snapshot-saved', `Imported workspace from file`);
        } catch (e) {
          console.error('Import failed:', e);
        }
      },
    });

    // ─── Tile Presets per Project ──────────────────────
    result.push({
      id: 'cmd-save-project-preset',
      label: 'Save Current Layout as Project Preset',
      category: 'workspace',
      action: () => {
        const store = useCanvasStore.getState();
        const pid = store.activeProject;
        if (!pid) return;
        const tiles = (store.tiles[pid] || []).map(t => {
          const { ...rest } = t as unknown as Record<string, unknown>;
          delete rest.ptyId;
          return rest;
        });
        localStorage.setItem(`tx-preset-${pid}`, JSON.stringify({ tiles, transform: store.transforms[pid] }));
        useTimelineStore.getState().recordEvent('snapshot-saved', 'Project preset saved');
      },
    });

    result.push({
      id: 'cmd-load-project-preset',
      label: 'Load Project Preset',
      category: 'workspace',
      action: () => {
        const store = useCanvasStore.getState();
        const pid = store.activeProject;
        try {
          const raw = localStorage.getItem(`tx-preset-${pid}`);
          if (!raw) { alert('No preset saved for this project'); return; }
          const preset = JSON.parse(raw);
          // Clear existing tiles
          const existing = store.tiles[pid] || [];
          for (const t of existing) store.removeTile(t.id);
          // Restore preset
          store.setTransform(preset.transform || { x: 0, y: 0, scale: 1 });
          for (const t of preset.tiles) {
            store.addTile({ ...t, id: crypto.randomUUID(), ptyId: undefined });
          }
        } catch {
          alert('Failed to load preset');
        }
      },
    });

    // ─── Sticky Note ─────────────────────────────────
    result.push({
      id: 'cmd-sticky-note',
      label: 'Add Sticky Note to Canvas',
      category: 'command',
      action: () => {
        const text = prompt('Sticky note text:');
        if (!text) return;
        const store = useCanvasStore.getState();
        const pid = store.activeProject;
        const t = store.transforms[pid] || { x: 0, y: 0, scale: 1 };
        const cx = (window.innerWidth / 2 - t.x) / t.scale;
        const cy = (window.innerHeight / 2 - t.y) / t.scale;
        store.addStickyNote(cx, cy, text);
      },
    });

    // ─── Time Travel ──────────────────────────────────
    result.push({
      id: 'cmd-time-travel',
      label: 'Time Travel — Rollback Workspace',
      category: 'workspace',
      action: () => {
        try {
          const pid = activeProject;
          const snapKeys = Object.keys(localStorage).filter(k => k.startsWith(`tx-autosnapshot-${pid}-`)).sort();
          if (snapKeys.length === 0) { alert('No snapshots available yet. Snapshots are saved automatically every 5 minutes.'); return; }
          const options = snapKeys.map(k => {
            const ts = k.replace(`tx-autosnapshot-${pid}-`, '');
            return new Date(parseInt(ts)).toLocaleTimeString();
          }).join('\n');
          const choice = prompt(`Available snapshots:\n${options}\n\nEnter time to rollback to (or leave blank for most recent):`);
          const targetKey = choice
            ? snapKeys.find(k => new Date(parseInt(k.replace(`tx-autosnapshot-${pid}-`, ''))).toLocaleTimeString().includes(choice))
            : snapKeys[snapKeys.length - 1];
          if (!targetKey) { alert('Snapshot not found'); return; }
          const data = JSON.parse(localStorage.getItem(targetKey) || '{}');
          if (data.tiles) {
            const store = useCanvasStore.getState();
            const existing = store.tiles[pid] || [];
            for (const t of existing) store.removeTile(t.id);
            store.setTransform(data.transform || { x: 0, y: 0, scale: 1 });
            for (const t of data.tiles) store.addTile({ ...t, id: crypto.randomUUID(), ptyId: undefined });
          }
        } catch { alert('Rollback failed'); }
      },
    });

    // ─── Multi-Agent Debate ────────────────────────────
    result.push({
      id: 'cmd-multi-agent-debate',
      label: 'Multi-Agent Debate (Claude vs Codex vs Gemini)',
      category: 'command',
      action: () => {
        const task = prompt('Enter the prompt to send to all agents:');
        if (!task) return;
        const store = useCanvasStore.getState();
        const pid = store.activeProject;
        const project = useProjectStore.getState().projects.find(p => p.id === pid);
        const cwd = project?.cwd || '~';
        const t = store.transforms[pid] || { x: 0, y: 0, scale: 1 };
        const cx = (window.innerWidth / 2 - t.x) / t.scale;
        const cy = (window.innerHeight / 2 - t.y) / t.scale;

        const agents = ['claude', 'codex', 'gemini'];
        const w = 450;
        const startX = cx - (agents.length * (w + 16)) / 2;

        for (let i = 0; i < agents.length; i++) {
          store.addTile({
            id: crypto.randomUUID(),
            type: 'agent',
            title: `${agents[i]} — debate`,
            agent: agents[i],
            model: agents[i] === 'claude' ? 'opus-4' : agents[i],
            effort: 'high', mode: 'code', version: '',
            cwd, branch: '', status: 'idle', elapsed: 0,
            x: startX + i * (w + 16),
            y: cy - 200,
            w,
            h: 400,
          } as unknown as import('@/types').Tile);
        }
      },
    });

    // ─── Toggle Agent Auto-Pipe ────────────────────────
    result.push({
      id: 'cmd-toggle-autopipe',
      label: 'Toggle Agent Auto-Pipe (hands-free piping)',
      category: 'command',
      action: () => {
        const store = useCanvasStore.getState();
        const focused = store.focusedTile;
        if (!focused) { alert('Focus an agent tile first.'); return; }
        const pid = store.activeProject;
        const tile = (store.tiles[pid] || []).find(t => t.id === focused);
        if (!tile || tile.type !== 'agent') { alert('Focused tile is not an agent.'); return; }
        const agentTile = tile as import('@/types').AgentTile;
        const next = agentTile.autoPipe !== true;
        store.updateTile(focused, { autoPipe: next } as Partial<import('@/types').AgentTile>);
      },
    });

    result.push({
      id: 'cmd-set-autoprompt',
      label: 'Set Agent Auto-Prompt (sent after auto-pipe)',
      category: 'command',
      action: () => {
        const store = useCanvasStore.getState();
        const focused = store.focusedTile;
        if (!focused) { alert('Focus an agent tile first.'); return; }
        const pid = store.activeProject;
        const tile = (store.tiles[pid] || []).find(t => t.id === focused);
        if (!tile || tile.type !== 'agent') { alert('Focused tile is not an agent.'); return; }
        const agentTile = tile as import('@/types').AgentTile;
        const current = agentTile.autoPromptTemplate ?? '';
        const input = prompt(
          'What should the agent do after receiving piped context? (leave blank to just pipe silently)\nExamples:\n- "Analyze the output above and explain what happened."\n- "If there are errors, fix them."\n- "Summarize in one paragraph."',
          current,
        );
        if (input === null) return;
        store.updateTile(focused, { autoPromptTemplate: input } as Partial<import('@/types').AgentTile>);
      },
    });

    // ─── Toggle Agent Auto-Complete ────────────────────
    result.push({
      id: 'cmd-toggle-autocomplete',
      label: 'Toggle Agent Auto-Complete (idle + DONE sentinel)',
      category: 'command',
      action: () => {
        const store = useCanvasStore.getState();
        const focused = store.focusedTile;
        if (!focused) { alert('Focus an agent tile first.'); return; }
        const pid = store.activeProject;
        const tile = (store.tiles[pid] || []).find(t => t.id === focused);
        if (!tile || tile.type !== 'agent') { alert('Focused tile is not an agent.'); return; }
        const agentTile = tile as import('@/types').AgentTile;
        const next = agentTile.autoComplete === false; // toggle; undefined counts as on
        store.updateTile(focused, { autoComplete: next } as Partial<import('@/types').AgentTile>);
      },
    });

    result.push({
      id: 'cmd-set-idle-threshold',
      label: 'Set Agent Idle Threshold (seconds)',
      category: 'command',
      action: () => {
        const store = useCanvasStore.getState();
        const focused = store.focusedTile;
        if (!focused) { alert('Focus an agent tile first.'); return; }
        const pid = store.activeProject;
        const tile = (store.tiles[pid] || []).find(t => t.id === focused);
        if (!tile || tile.type !== 'agent') { alert('Focused tile is not an agent.'); return; }
        const agentTile = tile as import('@/types').AgentTile;
        const current = (agentTile.idleThresholdMs ?? 8000) / 1000;
        const input = prompt('Seconds of silence before auto-completing (default 8):', String(current));
        if (!input) return;
        const secs = parseFloat(input);
        if (isNaN(secs) || secs < 1 || secs > 300) { alert('Value must be between 1 and 300.'); return; }
        store.updateTile(focused, { idleThresholdMs: Math.round(secs * 1000) } as Partial<import('@/types').AgentTile>);
      },
    });

    // ─── Agent Memory ─────────────────────────────────
    result.push({
      id: 'cmd-agent-memory',
      label: 'Set Agent Memory (Project Context)',
      category: 'command',
      action: async () => {
        const { useAgentMemoryStore } = await import('@/stores/agentMemoryStore');
        const pid = useCanvasStore.getState().activeProject;
        const current = useAgentMemoryStore.getState().getMemory(pid);
        const context = prompt('Agent memory — context shared with all new agents:\n(e.g., "Uses pnpm, API at /api/v2, Postgres DB")', current);
        if (context !== null) {
          useAgentMemoryStore.getState().setMemory(pid, context);
        }
      },
    });

    // ─── Prompt Library: Apply prompt to Agent ─────────
    // One palette entry per prompt. When selected, dispatches the
    // prompt to the currently-focused Agent tile. If no agent is
    // focused, shows a toast.
    import('@/stores/promptLibraryStore').then(({ usePromptLibraryStore, dispatchPrompt }) => {
      // This import is inside a .then so we don't force-load the store on
      // every palette render — it hydrates localStorage which is cheap,
      // but cleaner to keep lazy alongside plugin/template loads.
      const prompts = usePromptLibraryStore.getState().prompts;
      for (const p of prompts) {
        result.push({
          id: `prompt-${p.id}`,
          label: `${p.icon ? p.icon + ' ' : ''}${p.name}`,
          category: 'command',
          action: async () => {
            const store = useCanvasStore.getState();
            const pid = store.activeProject;
            const tiles = store.tiles[pid] || [];
            const focusedId = store.focusedTile;
            const focused = focusedId ? tiles.find(t => t.id === focusedId) : null;
            // Prefer focused agent; fall back to the last-spawned agent tile.
            const target = (focused && focused.type === 'agent' && 'ptyId' in focused && focused.ptyId)
              ? focused
              : [...tiles].reverse().find(t => t.type === 'agent' && 'ptyId' in t && (t as { ptyId?: string }).ptyId);
            if (!target || !('ptyId' in target) || !(target as { ptyId?: string }).ptyId) {
              const { useToastStore } = await import('@/stores/toastStore');
              useToastStore.getState().addToast(
                'No running agent tile to send this prompt to. Focus an agent first.',
                'warning',
              );
              return;
            }
            const { ptyWrite } = await import('@/utils/ipc');
            await dispatchPrompt((target as { ptyId: string }).ptyId, p, ptyWrite);
            const { useToastStore } = await import('@/stores/toastStore');
            useToastStore.getState().addToast(`Sent "${p.name}" to ${target.title || target.type}`, 'info');
          },
        });
      }
    });

    // ─── Prompt Library: Save current selection as prompt ─
    result.push({
      id: 'cmd-save-prompt',
      label: 'Save Prompt to Library…',
      category: 'command',
      action: async () => {
        const body = prompt('Prompt body (what will be sent to the agent):');
        if (!body) return;
        const name = prompt('Name (short label):') || 'Untitled';
        const description = prompt('Description (what this prompt does):') || '';
        const { usePromptLibraryStore } = await import('@/stores/promptLibraryStore');
        usePromptLibraryStore.getState().savePrompt({ name, description, body, tags: [] });
        const { useToastStore } = await import('@/stores/toastStore');
        useToastStore.getState().addToast(`Prompt "${name}" saved. Find it under ⌘K.`, 'info');
      },
    });

    // ─── Wire Blueprints: Save + apply whole patterns ───
    // Blueprints are multi-tile compositions with wires. Save = capture
    // the current canvas (or selection) as a named pattern. Apply =
    // materialize those tiles + wires on the active canvas.
    import('@/stores/blueprintStore').then(({ useBlueprintStore, captureBlueprint, instantiateBlueprint }) => {
      const blueprints = useBlueprintStore.getState().blueprints;

      // One palette entry per blueprint (Apply)
      for (const bp of blueprints) {
        result.push({
          id: `blueprint-apply-${bp.id}`,
          label: `${bp.icon ? bp.icon + ' ' : '🧩 '}Apply: ${bp.name}`,
          category: 'workspace',
          action: async () => {
            const store = useCanvasStore.getState();
            const transform = store.transforms[store.activeProject] ?? { x: 0, y: 0, scale: 1 };
            const anchor = screenToCanvas(window.innerWidth / 2 - 300, 100, transform);
            const { tiles: newTiles, wires: newWires } = instantiateBlueprint(bp, anchor);
            for (const t of newTiles) store.addTile(t);
            for (const w of newWires) store.addWire(w);
            const { useToastStore } = await import('@/stores/toastStore');
            useToastStore.getState().addToast(
              `Applied "${bp.name}" — ${newTiles.length} tiles + ${newWires.length} wires.`,
              'info',
            );
          },
        });
      }

      // Save canvas as blueprint
      result.push({
        id: 'cmd-save-blueprint',
        label: '💾 Save Canvas as Blueprint…',
        category: 'workspace',
        action: async () => {
          const store = useCanvasStore.getState();
          const pid = store.activeProject;
          const tiles = store.tiles[pid] || [];
          const wires = store.wires[pid] || [];
          if (tiles.length === 0) {
            const { useToastStore } = await import('@/stores/toastStore');
            useToastStore.getState().addToast('Canvas is empty — nothing to save.', 'warning');
            return;
          }
          const name = prompt(`Blueprint name (captures ${tiles.length} tiles + ${wires.length} wires):`);
          if (!name) return;
          const description = prompt('Short description:') || '';
          const bp = captureBlueprint(name, description, tiles, wires);
          useBlueprintStore.getState().saveBlueprint(bp);
          const { useToastStore } = await import('@/stores/toastStore');
          useToastStore.getState().addToast(`Blueprint "${name}" saved.`, 'info');
        },
      });

      // Save selection as blueprint
      result.push({
        id: 'cmd-save-selection-blueprint',
        label: '💾 Save Selection as Blueprint…',
        category: 'workspace',
        action: async () => {
          const store = useCanvasStore.getState();
          const pid = store.activeProject;
          const selected = store.selectedTiles;
          if (selected.length === 0) {
            const { useToastStore } = await import('@/stores/toastStore');
            useToastStore.getState().addToast('No tiles selected. Shift-drag to select first.', 'warning');
            return;
          }
          const allTiles = store.tiles[pid] || [];
          const allWires = store.wires[pid] || [];
          const selectedSet = new Set(selected);
          const selTiles = allTiles.filter(t => selectedSet.has(t.id));
          const selWires = allWires.filter(w => selectedSet.has(w.fromTile) && selectedSet.has(w.toTile));
          const name = prompt(`Blueprint name (${selTiles.length} tiles + ${selWires.length} wires):`);
          if (!name) return;
          const description = prompt('Short description:') || '';
          const bp = captureBlueprint(name, description, selTiles, selWires);
          useBlueprintStore.getState().saveBlueprint(bp);
          const { useToastStore } = await import('@/stores/toastStore');
          useToastStore.getState().addToast(`Blueprint "${name}" saved from selection.`, 'info');
        },
      });
    });

    // ─── Starter Layout: Detect + apply ────────────────
    // Scans the active project's cwd, guesses the language/framework,
    // and spawns a matching starter tile set. Idempotent — if the
    // suggested tiles already exist, skips them.
    result.push({
      id: 'cmd-starter-layout',
      label: 'Suggest Starter Layout for This Project',
      category: 'workspace',
      action: async () => {
        const store = useCanvasStore.getState();
        const pStore = useProjectStore.getState();
        const project = pStore.projects.find(p => p.id === store.activeProject);
        if (!project) {
          const { useToastStore } = await import('@/stores/toastStore');
          useToastStore.getState().addToast('No active project. Add one first.', 'warning');
          return;
        }
        const { detectProjectKind } = await import('@/utils/projectTypeDetect');
        const detected = await detectProjectKind(project.cwd);
        if (!detected) {
          const { useToastStore } = await import('@/stores/toastStore');
          useToastStore.getState().addToast(
            "Couldn't detect a known project type from the cwd. Try spawning tiles manually.",
            'info',
          );
          return;
        }
        const ok = confirm(
          `Detected: ${detected.label}\n\nSpawn ${detected.starterTiles.length} tiles for this project?`,
        );
        if (!ok) return;

        // Column-major spawn grid, same pitch as the dock spawn.
        const { TILE_DEFAULTS } = await import('@/App');
        const anchor = screenToCanvas(24, 24, store.transforms[store.activeProject] ?? { x: 0, y: 0, scale: 1 });
        const SLOT_W = 700, SLOT_H = 500, GAP = 8, ROWS = 3;
        let idx = 0;
        for (const entry of detected.starterTiles) {
          const col = Math.floor(idx / ROWS);
          const row = idx % ROWS;
          const x = Math.round(anchor.x + col * (SLOT_W + GAP));
          const y = Math.round(anchor.y + row * (SLOT_H + GAP));
          const defaults = TILE_DEFAULTS[entry.type];
          store.addTile({
            id: crypto.randomUUID(),
            type: entry.type,
            x, y,
            w: defaults.w,
            h: defaults.h,
            title: entry.type.charAt(0).toUpperCase() + entry.type.slice(1),
            cwd: project.cwd,
            ...(entry.config || {}),
          } as Parameters<typeof store.addTile>[0]);
          idx += 1;
        }
        const { useToastStore } = await import('@/stores/toastStore');
        useToastStore.getState().addToast(
          `Starter layout applied for ${detected.label}.`,
          'info',
        );
      },
    });

    // ─── Plugin: Register ──────────────────────────────
    result.push({
      id: 'cmd-register-plugin',
      label: 'Register Plugin',
      category: 'command',
      action: async () => {
        const { usePluginStore } = await import('@/stores/pluginStore');
        const { httpFetch } = await import('@/utils/ipc');
        const input = prompt('Plugin manifest URL (https only) or paste JSON:');
        if (!input) return;
        try {
          let manifest;
          if (input.startsWith('{')) {
            manifest = JSON.parse(input);
          } else {
            // Route through the Rust proxy so SSRF / private-IP guards apply.
            // Only https is accepted; http/file/other schemes are rejected.
            if (!/^https:\/\//i.test(input)) {
              alert('Plugin manifest URL must use https://');
              return;
            }
            const res = await httpFetch({ url: input, method: 'GET' });
            if (res.status < 200 || res.status >= 300) {
              alert(`Failed to fetch manifest: HTTP ${res.status}`);
              return;
            }
            manifest = JSON.parse(res.body);
          }
          if (!manifest.id || !manifest.name || !manifest.tileType) {
            alert('Invalid plugin manifest: must have id, name, and tileType');
            return;
          }
          // entryUrl must be https so the sandboxed iframe can't reach file://, data:, or localhost.
          if (manifest.entryUrl && !/^https:\/\//i.test(manifest.entryUrl)) {
            alert('Plugin entryUrl must be https://');
            return;
          }
          const confirmed = confirm(
            `Register plugin "${manifest.name}"?\n\n` +
            `It will load ${manifest.entryUrl || '(no UI)'} in a sandboxed iframe. ` +
            `Only install plugins from sources you trust.`,
          );
          if (!confirmed) return;
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
      if (results.length === 0) return;
      setSelectedIndex(i => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
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
