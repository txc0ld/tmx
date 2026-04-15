import { useState, useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useMcpStore, MCP_DEFINITIONS, type McpTask, type McpType } from '@/stores/mcpStore';
import { ptyWrite } from '@/utils/ipc';
import { MCP_SYNC_INTERVAL_MS } from '@/utils/constants';
import { colors, radius, spacing, typography, fonts, motion, alpha } from '@/design/tokens';
import type { TodoTile as TodoTileType, TodoItem, AgentTile as AgentTileType, Wire } from '@/types';

interface TodoTileProps {
  tile: TodoTileType;
}

const EMPTY_ITEMS: TodoItem[] = [];
const EMPTY_TASKS: McpTask[] = [];

const MCP_ICONS: Record<string, string> = {
  github: '⬡', linear: '△', slack: '#', jira: '◇', notion: 'N',
  'google-calendar': '◉', gmail: '✉', custom: '⚙',
};

export function TodoTile({ tile }: TodoTileProps) {
  const [input, setInput] = useState('');
  const [showMcp, setShowMcp] = useState(false);
  const items = tile.items ?? EMPTY_ITEMS;
  const activeProject = useCanvasStore(s => s.activeProject);
  const mcpTasks = useMcpStore(s => s.tasksByProject[activeProject] ?? EMPTY_TASKS);
  const mcpConnections = useMcpStore(s => s.connections);

  const autoDispatch = tile.autoDispatch ?? false;
  const prevTaskCountRef = useRef(mcpTasks.length);

  // Auto-sync MCP tasks on mount + every 5 minutes
  useEffect(() => {
    if (mcpConnections.length === 0) return;
    useMcpStore.getState().syncAll();
    const interval = setInterval(() => useMcpStore.getState().syncAll(), MCP_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [mcpConnections.length]);

  // Auto-dispatch: when new MCP tasks arrive, send them to a connected agent
  useEffect(() => {
    if (!autoDispatch) { prevTaskCountRef.current = mcpTasks.length; return; }
    if (mcpTasks.length <= prevTaskCountRef.current) { prevTaskCountRef.current = mcpTasks.length; return; }

    const newTasks = mcpTasks.slice(prevTaskCountRef.current);
    prevTaskCountRef.current = mcpTasks.length;
    if (newTasks.length === 0) return;

    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const allTiles = store.tiles[pid] || [];
    const allWires: Wire[] = store.wires[pid] || [];

    const wiredAgentId = allWires.find(w => w.fromTile === tile.id && allTiles.find(t => t.id === w.toTile && t.type === 'agent'))?.toTile;
    let targetAgent = wiredAgentId ? allTiles.find(t => t.id === wiredAgentId) as AgentTileType | undefined : undefined;
    if (!targetAgent) {
      targetAgent = allTiles.find(t => t.type === 'agent' && (t as AgentTileType).ptyId) as AgentTileType | undefined;
    }
    if (!targetAgent?.ptyId) return;

    const ptyId = targetAgent.ptyId;

    // Write full text to PTY in small chunks to avoid buffer truncation
    const writeChunked = (id: string, text: string): Promise<void> => {
      return new Promise((resolve) => {
        const CHUNK = 128;
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += CHUNK) {
          chunks.push(text.slice(i, i + CHUNK));
        }
        let i = 0;
        const next = () => {
          if (i >= chunks.length) { resolve(); return; }
          ptyWrite(id, chunks[i]).catch(() => {});
          i++;
          setTimeout(next, 50);
        };
        next();
      });
    };

    let delay = 0;
    for (const task of newTasks) {
      const d = delay;
      setTimeout(() => {
        writeChunked(ptyId, task.text).then(() => {
          setTimeout(() => ptyWrite(ptyId, '\r').catch(() => {}), 300);
        });
      }, d);
      delay += Math.max(3000, task.text.length * 2);

      const item: TodoItem = { id: crypto.randomUUID(), text: `[auto] ${task.text.slice(0, 80)}`, done: false, assignedAgent: task.source };
      const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as TodoTileType | undefined;
      store.updateTile(tile.id, { items: [...(current?.items ?? []), item] });
      useMcpStore.getState().markSeen(task.id);
      useMcpStore.getState().dismissTask(task.id);
    }
  }, [mcpTasks.length, autoDispatch, tile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAutoDispatch = () => {
    useCanvasStore.getState().updateTile(tile.id, { autoDispatch: !autoDispatch } as Partial<TodoTileType>);
  };

  const updateItems = (next: TodoItem[]) => {
    useCanvasStore.getState().updateTile(tile.id, { items: next });
  };

  const toggleItem = (id: string) => {
    updateItems(items.map(i => i.id === id ? { ...i, done: !i.done } : i));
  };

  const removeItem = (id: string) => {
    updateItems(items.filter(i => i.id !== id));
  };

  const addItem = () => {
    const text = input.trim();
    if (!text) return;
    const item: TodoItem = { id: crypto.randomUUID(), text, done: false };
    updateItems([...items, item]);
    setInput('');
  };

  const importMcpTask = (task: McpTask) => {
    if (items.some(i => i.text === task.text)) return;
    const item: TodoItem = {
      id: crypto.randomUUID(),
      text: task.text,
      done: task.done,
      assignedAgent: task.source,
    };
    updateItems([...items, item]);
    // Mark as seen so it doesn't reappear on next sync
    useMcpStore.getState().markSeen(task.id);
    useMcpStore.getState().dismissTask(task.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: `3px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0, gap: 2,
      }}>
        <button
          onClick={() => setShowMcp(false)}
          style={tabBtnStyle(!showMcp)}
        >
          Tasks ({items.length})
        </button>
        <button
          onClick={() => setShowMcp(true)}
          style={tabBtnStyle(showMcp)}
        >
          MCP ({mcpConnections.length})
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          {mcpTasks.length > 0 && !showMcp && (
            <span style={{
              ...typography.labelSm, fontSize: '0.5625rem',
              color: colors.primary,
              background: alpha(colors.primary, 10),
              padding: '1px 5px', borderRadius: radius.sm,
            }}>
              {mcpTasks.length} new
            </span>
          )}
          <button
            onClick={toggleAutoDispatch}
            title={autoDispatch ? 'Auto-dispatch ON — new tasks sent to agent automatically' : 'Auto-dispatch OFF — tasks stay in queue'}
            style={{
              display: 'flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', borderRadius: radius.sm,
              border: `1px solid ${autoDispatch ? colors.green : colors.outlineGhost}`,
              background: autoDispatch ? alpha(colors.green, 12) : 'transparent',
              color: autoDispatch ? colors.green : colors.secondary,
              cursor: 'pointer',
              ...typography.labelSm, fontSize: '0.5625rem',
              fontFamily: fonts.mono,
              transition: `all ${motion.hover}`,
            }}
          >
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: autoDispatch ? colors.green : colors.secondary,
            }} />
            Auto
          </button>
        </div>
      </div>

      {!showMcp ? (
        <>
          {/* Items */}
          <div style={{ flex: 1, overflowY: 'auto', padding: `${spacing.xs} 0` }}>
            {items.map(item => (
              <div
                key={item.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: spacing.sm,
                  padding: `4px ${spacing.sm}`,
                }}
              >
                <div
                  onClick={() => toggleItem(item.id)}
                  style={{
                    width: 16, height: 16, borderRadius: radius.sm,
                    border: `1.5px solid ${item.done ? colors.primary : colors.outlineVariant}`,
                    background: item.done ? colors.primary : 'transparent',
                    cursor: 'pointer', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: `all ${motion.hover}`,
                  }}
                >
                  {item.done && <span style={{ fontSize: 10, color: colors.bg, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{
                  ...typography.bodyMd, color: colors.onSurfaceVariant, flex: 1,
                  textDecoration: item.done ? 'line-through' : 'none',
                  opacity: item.done ? 0.5 : 1,
                }}>
                  {item.text}
                </span>
                {item.assignedAgent && (
                  <span style={{
                    ...typography.labelSm, fontSize: '0.5rem',
                    color: colors.secondary, fontFamily: fonts.mono,
                  }}>
                    {MCP_ICONS[item.assignedAgent] || ''}{item.assignedAgent}
                  </span>
                )}
                <button
                  onClick={() => removeItem(item.id)}
                  style={{
                    background: 'none', border: 'none', color: colors.secondary,
                    cursor: 'pointer', fontSize: 10, padding: '0 2px',
                    fontFamily: fonts.mono, lineHeight: 1,
                    transition: `color ${motion.hover}`,
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = colors.red}
                  onMouseLeave={e => e.currentTarget.style.color = colors.secondary}
                >
                  ✕
                </button>
              </div>
            ))}

            {/* MCP synced tasks (import buttons) */}
            {mcpTasks.length > 0 && (
              <div style={{ padding: `${spacing.xs} ${spacing.sm}`, borderTop: `1px solid ${colors.outlineGhost}`, marginTop: spacing.xs }}>
                <div style={{ ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem', marginBottom: 4 }}>
                  FROM INTEGRATIONS
                </div>
                {mcpTasks.slice(0, 10).map(task => (
                  <div
                    key={task.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '3px 4px', borderRadius: radius.sm,
                    }}
                  >
                    <span style={{ fontSize: 10, color: colors.secondary, width: 14, textAlign: 'center' }}>
                      {MCP_ICONS[task.source] || '+'}
                    </span>
                    <span style={{
                      ...typography.labelSm, color: colors.onSurfaceVariant, flex: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {task.text}
                    </span>
                    <button
                      onClick={() => importMcpTask(task)}
                      style={{
                        background: 'none', border: `1px solid ${colors.outlineGhost}`,
                        borderRadius: radius.sm, padding: '1px 5px',
                        color: colors.secondary, cursor: 'pointer',
                        ...typography.labelSm, fontSize: '0.5rem',
                        fontFamily: fonts.mono, transition: `color ${motion.hover}`,
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = colors.primary}
                      onMouseLeave={e => e.currentTarget.style.color = colors.secondary}
                    >
                      + add
                    </button>
                    <button
                      onClick={() => useMcpStore.getState().dismissTask(task.id)}
                      style={{
                        background: 'none', border: 'none', padding: '0 2px',
                        color: colors.secondary, cursor: 'pointer',
                        fontSize: 9, fontFamily: fonts.mono, lineHeight: 1,
                        transition: `color ${motion.hover}`,
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = colors.red}
                      onMouseLeave={e => e.currentTarget.style.color = colors.secondary}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add input + actions */}
          <div style={{ borderTop: `1px solid ${colors.outlineGhost}`, padding: spacing.sm, flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
                placeholder="Add task..."
                style={{
                  flex: 1, background: 'transparent', border: 'none',
                  color: colors.onSurfaceVariant, fontFamily: fonts.body,
                  fontSize: '0.875rem', outline: 'none',
                }}
              />
              {items.some(i => i.done) && (
                <button
                  onClick={() => updateItems(items.filter(i => !i.done))}
                  style={{
                    background: 'none', border: `1px solid ${colors.outlineGhost}`,
                    borderRadius: radius.sm, padding: '2px 6px',
                    color: colors.secondary, cursor: 'pointer',
                    ...typography.labelSm, fontSize: '0.5625rem',
                    fontFamily: fonts.mono, whiteSpace: 'nowrap',
                    transition: `color ${motion.hover}`,
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = colors.red}
                  onMouseLeave={e => e.currentTarget.style.color = colors.secondary}
                >
                  Clear done
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <McpPanel />
      )}
    </div>
  );
}

// ─── MCP Settings Panel ────────────────────────────────

function McpPanel() {
  const connections = useMcpStore(s => s.connections);
  const [adding, setAdding] = useState<McpType | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  const handleAdd = () => {
    if (!adding) return;
    const def = MCP_DEFINITIONS.find(d => d.type === adding);
    if (!def) return;
    useMcpStore.getState().addConnection({
      name: def.name,
      type: adding,
      config: { ...configValues },
    });
    setAdding(null);
    setConfigValues({});
    // Auto-sync the new connection
    setTimeout(() => {
      const conns = useMcpStore.getState().connections;
      const newest = conns[conns.length - 1];
      if (newest) useMcpStore.getState().syncConnection(newest.id);
    }, 100);
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: spacing.sm }}>
      {/* Existing connections */}
      {connections.map(conn => (
        <div key={conn.id} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 8px', marginBottom: 4,
          border: `1px solid ${colors.outlineGhost}`,
          borderRadius: radius.sm,
        }}>
          <span style={{ fontSize: 12, width: 16, textAlign: 'center' }}>
            {MCP_ICONS[conn.type] || '?'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...typography.labelMd, color: colors.onSurface }}>{conn.name}</div>
            <div style={{
              ...typography.labelSm, fontSize: '0.5625rem',
              color: conn.status === 'connected' ? colors.green
                   : conn.status === 'error' ? colors.red
                   : colors.secondary,
            }}>
              {conn.status}{conn.error ? ` — ${conn.error}` : ''}
            </div>
          </div>
          <button
            onClick={() => useMcpStore.getState().syncConnection(conn.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.onSurfaceVariant, fontSize: 10 }}
          >
            &#8635;
          </button>
          <button
            onClick={() => useMcpStore.getState().removeConnection(conn.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.red, fontSize: 10, fontFamily: fonts.mono }}
          >
            ✕
          </button>
        </div>
      ))}

      {/* Add new connection */}
      {!adding ? (
        <div style={{ marginTop: spacing.sm }}>
          <div style={{ ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Add Integration
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {MCP_DEFINITIONS.map(def => (
              <button
                key={def.type}
                onClick={() => { setAdding(def.type); setConfigValues({}); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: radius.sm,
                  border: `1px solid ${colors.outlineGhost}`,
                  background: 'none', cursor: 'pointer',
                  color: colors.onSurfaceVariant,
                  ...typography.labelSm, fontFamily: fonts.mono,
                  transition: `background ${motion.hover}`,
                }}
                onMouseEnter={e => e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 5)}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span style={{ fontSize: 10 }}>{def.icon}</span>
                {def.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: spacing.sm }}>
          <div style={{ ...typography.labelMd, color: colors.onSurface, marginBottom: 6 }}>
            {MCP_DEFINITIONS.find(d => d.type === adding)?.name}
          </div>
          <div style={{ ...typography.labelSm, color: colors.secondary, marginBottom: 8 }}>
            {MCP_DEFINITIONS.find(d => d.type === adding)?.description}
          </div>
          {MCP_DEFINITIONS.find(d => d.type === adding)?.configFields.map(field => (
            <input
              key={field.key}
              type={field.secret ? 'password' : 'text'}
              value={configValues[field.key] || ''}
              onChange={e => setConfigValues(v => ({ ...v, [field.key]: e.target.value }))}
              placeholder={field.placeholder || field.label}
              style={{
                width: '100%', marginBottom: 6,
                padding: '5px 8px',
                background: 'transparent',
                border: `1px solid ${colors.outlineGhost}`,
                borderRadius: radius.sm,
                color: colors.onSurface,
                fontFamily: fonts.mono, fontSize: '0.6875rem',
                outline: 'none',
              }}
            />
          ))}
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
            <button
              onClick={() => { setAdding(null); setConfigValues({}); }}
              style={{
                padding: '4px 10px', background: 'none',
                border: `1px solid ${colors.outlineGhost}`,
                borderRadius: radius.sm, color: colors.onSurfaceVariant,
                ...typography.labelSm, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              style={{
                padding: '4px 10px', background: colors.primary,
                border: 'none', borderRadius: radius.sm, color: colors.bg,
                ...typography.labelSm, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', borderRadius: radius.sm,
    border: 'none', cursor: 'pointer',
    background: active ? colors.surfaceHigh : 'transparent',
    color: active ? colors.primary : colors.onSurfaceVariant,
    boxShadow: active ? `inset 0 -2px 0 ${colors.primary}` : 'none',
    ...typography.labelSm, fontFamily: fonts.mono,
    fontWeight: active ? 600 : 500,
    transition: `all ${motion.hover}`,
  };
}
