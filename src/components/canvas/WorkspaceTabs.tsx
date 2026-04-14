import { useState, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, radius, typography, fonts, motion, alpha } from '@/design/tokens';

const DEFAULT_WORKSPACE_NAMES: string[] = ['Default'];

export function WorkspaceTabs() {
  const activeProject = useCanvasStore(s => s.activeProject);
  const workspaceNames = useCanvasStore(s => s.workspaceNames[s.activeProject] ?? DEFAULT_WORKSPACE_NAMES);
  const activeWorkspace = useCanvasStore(s => s.activeWorkspace[s.activeProject] ?? 'Default');

  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const handleAdd = useCallback(() => {
    const name = newName.trim();
    if (name) {
      useCanvasStore.getState().createWorkspace(name);
    }
    setNewName('');
    setIsAdding(false);
  }, [newName]);

  const handleDelete = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    useCanvasStore.getState().deleteWorkspace(name);
  }, []);

  if (!activeProject) return null;

  // Only show when user has created workspaces
  if (workspaceNames.length <= 1 && workspaceNames[0] === 'Default') return null;

  return (
    <div data-canvas-overlay style={{
      position: 'absolute',
      top: 8,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      padding: '2px 4px',
      background: colors.surfaceLow,
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderRadius: radius.full,
      border: `1px solid ${colors.outlineGhost}`,
      zIndex: 50,
    }}>
      {workspaceNames.map(name => {
        const isActive = name === activeWorkspace;
        return (
          <button
            key={name}
            onClick={() => useCanvasStore.getState().switchWorkspace(name)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 10px',
              borderRadius: radius.full,
              border: 'none',
              background: isActive ? alpha(colors.primary, 15) : 'transparent',
              cursor: 'pointer',
              transition: `all ${motion.hover}`,
              ...typography.labelSm,
              fontFamily: fonts.mono,
              color: isActive ? colors.primary : colors.onSurfaceVariant,
            }}
            onMouseEnter={e => {
              if (!isActive) e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 8);
            }}
            onMouseLeave={e => {
              if (!isActive) e.currentTarget.style.background = 'transparent';
            }}
          >
            {name}
            {workspaceNames.length > 1 && (
              <span
                onClick={(e) => handleDelete(name, e)}
                style={{
                  marginLeft: 2,
                  fontSize: '0.5rem',
                  opacity: 0.5,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}

      {isAdding ? (
        <input
          autoFocus
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleAdd();
            if (e.key === 'Escape') { setIsAdding(false); setNewName(''); }
          }}
          onBlur={handleAdd}
          placeholder="name..."
          style={{
            width: 80,
            padding: '2px 6px',
            borderRadius: radius.sm,
            border: `1px solid ${colors.outlineVariant}`,
            background: colors.surfaceLowest,
            color: colors.onSurface,
            ...typography.labelSm,
            fontFamily: fonts.mono,
            outline: 'none',
          }}
        />
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: radius.full,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: colors.onSurfaceVariant,
            fontSize: '0.75rem',
            fontFamily: fonts.mono,
            transition: `all ${motion.hover}`,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 8);
            e.currentTarget.style.color = colors.primary;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = colors.onSurfaceVariant;
          }}
          title="New workspace"
        >
          +
        </button>
      )}
    </div>
  );
}
