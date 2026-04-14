import { useState } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, radius, spacing, typography, fonts, motion } from '@/design/tokens';
import type { KanbanTile as KanbanTileType, KanbanColumn, KanbanItem } from '@/types';

interface KanbanTileProps {
  tile: KanbanTileType;
}

const EMPTY_COLUMNS: KanbanColumn[] = [];

export function KanbanTile({ tile }: KanbanTileProps) {
  const [addingColumnInput, setAddingColumnInput] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [addingItemColumn, setAddingItemColumn] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState('');

  const columns = tile.columns ?? EMPTY_COLUMNS;

  const updateColumns = (cols: KanbanColumn[]) => {
    useCanvasStore.getState().updateTile(tile.id, { columns: cols });
  };

  // ─── Column operations ─────────────────────────────────────
  const addColumn = () => {
    const title = newColumnTitle.trim();
    if (!title) return;
    const col: KanbanColumn = { id: crypto.randomUUID(), title, items: [] };
    updateColumns([...columns, col]);
    setNewColumnTitle('');
    setAddingColumnInput(false);
  };

  const removeColumn = (colId: string) => {
    updateColumns(columns.filter(c => c.id !== colId));
  };

  // ─── Item operations ───────────────────────────────────────
  const addItem = (colId: string) => {
    const text = newItemText.trim();
    if (!text) return;
    const item: KanbanItem = { id: crypto.randomUUID(), text };
    updateColumns(
      columns.map(c =>
        c.id === colId ? { ...c, items: [...c.items, item] } : c
      )
    );
    setNewItemText('');
    setAddingItemColumn(null);
  };

  const removeItem = (colId: string, itemId: string) => {
    updateColumns(
      columns.map(c =>
        c.id === colId
          ? { ...c, items: c.items.filter(i => i.id !== itemId) }
          : c
      )
    );
  };

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      overflowX: 'auto',
      overflowY: 'hidden',
      gap: spacing.sm,
      padding: spacing.sm,
    }}>
      {/* Columns */}
      {columns.map(col => (
        <div
          key={col.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 200,
            maxWidth: 260,
            flexShrink: 0,
            background: colors.surfaceLowest,
            borderRadius: radius.lg,
            border: `1px solid ${colors.outlineGhost}`,
          }}
        >
          {/* Column header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${spacing.sm} ${spacing.sm}`,
              borderBottom: `1px solid ${colors.outlineGhost}`,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
              <span style={{
                ...typography.labelMd,
                color: colors.onSurface,
              }}>
                {col.title}
              </span>
              <span style={{
                ...typography.labelSm,
                color: colors.onSurfaceVariant,
                opacity: 0.6,
              }}>
                {col.items.length}
              </span>
            </div>
            <button
              onClick={() => removeColumn(col.id)}
              style={{
                background: 'none',
                border: 'none',
                color: colors.onSurfaceVariant,
                cursor: 'pointer',
                fontSize: 11,
                padding: 0,
                opacity: 0.4,
                transition: `opacity ${motion.hover}`,
                fontFamily: fonts.mono,
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '0.4'; }}
            >
              ✕
            </button>
          </div>

          {/* Items list */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: spacing.xs,
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xs,
          }}>
            {col.items.map(item => (
              <div
                key={item.id}
                style={{
                  background: colors.surfaceLow,
                  borderRadius: radius.md,
                  padding: `${spacing.xs} ${spacing.sm}`,
                  border: `1px solid ${colors.outlineGhost}`,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: spacing.xs,
                  transition: `background ${motion.hover}`,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = colors.surface;
                  const del = e.currentTarget.querySelector('[data-delete]') as HTMLElement;
                  if (del) del.style.opacity = '1';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = colors.surfaceLow;
                  const del = e.currentTarget.querySelector('[data-delete]') as HTMLElement;
                  if (del) del.style.opacity = '0';
                }}
              >
                {item.color && (
                  <div style={{
                    width: 4,
                    minHeight: 14,
                    borderRadius: radius.full,
                    background: item.color,
                    flexShrink: 0,
                    marginTop: 2,
                  }} />
                )}
                <span style={{
                  ...typography.bodyMd,
                  fontSize: '0.8125rem',
                  color: colors.onSurfaceVariant,
                  flex: 1,
                  wordBreak: 'break-word',
                }}>
                  {item.text}
                </span>
                <button
                  data-delete
                  onClick={() => removeItem(col.id, item.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: colors.onSurfaceVariant,
                    cursor: 'pointer',
                    fontSize: 10,
                    padding: 0,
                    opacity: 0,
                    transition: `opacity ${motion.hover}`,
                    fontFamily: fonts.mono,
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Add item */}
          <div style={{
            borderTop: `1px solid ${colors.outlineGhost}`,
            padding: spacing.xs,
            flexShrink: 0,
          }}>
            {addingItemColumn === col.id ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
                <input
                  autoFocus
                  value={newItemText}
                  onChange={e => setNewItemText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addItem(col.id);
                    if (e.key === 'Escape') { setAddingItemColumn(null); setNewItemText(''); }
                  }}
                  placeholder="Item text..."
                  style={{
                    width: '100%',
                    background: colors.surfaceLow,
                    border: `1px solid ${colors.outlineVariant}`,
                    borderRadius: radius.sm,
                    color: colors.onSurfaceVariant,
                    fontFamily: fonts.body,
                    fontSize: '0.8125rem',
                    padding: `3px ${spacing.xs}`,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: spacing.xs }}>
                  <button
                    onClick={() => addItem(col.id)}
                    style={{
                      background: colors.primary,
                      border: 'none',
                      borderRadius: radius.sm,
                      color: colors.bg,
                      fontFamily: fonts.body,
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      padding: `2px ${spacing.sm}`,
                      cursor: 'pointer',
                    }}
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAddingItemColumn(null); setNewItemText(''); }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.onSurfaceVariant,
                      fontFamily: fonts.body,
                      fontSize: '0.6875rem',
                      cursor: 'pointer',
                      padding: `2px ${spacing.xs}`,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setAddingItemColumn(col.id); setNewItemText(''); }}
                style={{
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: colors.onSurfaceVariant,
                  opacity: 0.5,
                  cursor: 'pointer',
                  fontFamily: fonts.body,
                  fontSize: '0.75rem',
                  padding: `2px 0`,
                  textAlign: 'left',
                  transition: `opacity ${motion.hover}`,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; }}
              >
                + Add item
              </button>
            )}
          </div>
        </div>
      ))}

      {/* Add column */}
      <div style={{
        minWidth: 180,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'flex-start',
        paddingTop: spacing.xs,
      }}>
        {addingColumnInput ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xs,
            width: 200,
            background: colors.surfaceLowest,
            borderRadius: radius.lg,
            border: `1px solid ${colors.outlineGhost}`,
            padding: spacing.sm,
          }}>
            <input
              autoFocus
              value={newColumnTitle}
              onChange={e => setNewColumnTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addColumn();
                if (e.key === 'Escape') { setAddingColumnInput(false); setNewColumnTitle(''); }
              }}
              placeholder="Column title..."
              style={{
                width: '100%',
                background: colors.surfaceLow,
                border: `1px solid ${colors.outlineVariant}`,
                borderRadius: radius.sm,
                color: colors.onSurfaceVariant,
                fontFamily: fonts.body,
                fontSize: '0.8125rem',
                padding: `4px ${spacing.xs}`,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: spacing.xs }}>
              <button
                onClick={addColumn}
                style={{
                  background: colors.primary,
                  border: 'none',
                  borderRadius: radius.sm,
                  color: colors.bg,
                  fontFamily: fonts.body,
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  padding: `3px ${spacing.sm}`,
                  cursor: 'pointer',
                }}
              >
                Add
              </button>
              <button
                onClick={() => { setAddingColumnInput(false); setNewColumnTitle(''); }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.onSurfaceVariant,
                  fontFamily: fonts.body,
                  fontSize: '0.6875rem',
                  cursor: 'pointer',
                  padding: `3px ${spacing.xs}`,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAddingColumnInput(true)}
            style={{
              background: colors.surfaceLowest,
              border: `1px dashed ${colors.outlineVariant}`,
              borderRadius: radius.lg,
              color: colors.onSurfaceVariant,
              opacity: 0.5,
              cursor: 'pointer',
              fontFamily: fonts.body,
              fontSize: '0.8125rem',
              padding: `${spacing.sm} ${spacing.md}`,
              transition: `opacity ${motion.hover}`,
              width: 200,
              textAlign: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; }}
          >
            + Add column
          </button>
        )}
      </div>
    </div>
  );
}
