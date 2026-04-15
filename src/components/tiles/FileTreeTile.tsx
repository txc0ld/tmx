import { useState, useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { readFileTree } from '@/utils/ipc';
import { colors, fonts, spacing, typography, radius, alpha } from '@/design/tokens';
import type { FileTreeTile as FileTreeTileType, FileTreeNode, EditorTile, DiffTile, Tile } from '@/types';

interface FileTreeTileProps {
  tile: FileTreeTileType;
}

const EMPTY_NODES: FileTreeNode[] = [];
const EMPTY_PATHS: string[] = [];

export function FileTreeTile({ tile }: FileTreeTileProps) {
  const [nodes, setNodes] = useState<FileTreeNode[]>(EMPTY_NODES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    readFileTree(tile.rootPath, 4)
      .then((result) => {
        setNodes(result as FileTreeNode[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [tile.rootPath]);

  const handleToggleExpand = useCallback((path: string) => {
    const expanded = tile.expandedPaths ?? EMPTY_PATHS;
    const next = expanded.includes(path)
      ? expanded.filter(p => p !== path)
      : [...expanded, path];
    useCanvasStore.getState().updateTile(tile.id, { expandedPaths: next } as Partial<FileTreeTileType>);
  }, [tile.id, tile.expandedPaths]);

  const handleSelectFile = useCallback((path: string) => {
    const store = useCanvasStore.getState();
    store.updateTile(tile.id, { selectedFile: path } as Partial<FileTreeTileType>);

    const pid = store.activeProject;
    const allTiles = store.tiles[pid] || [];
    const wires = store.wires[pid] || [];

    // If this filetree has any file-open wires, route the click through them
    // instead of spawning a new editor every time. Multiple targets are OK —
    // each one receives the path.
    const fileOpenWires = wires.filter(w => w.fromTile === tile.id && w.wireType === 'file-open');

    if (fileOpenWires.length > 0) {
      let routed = false;
      for (const wire of fileOpenWires) {
        const target = allTiles.find(t => t.id === wire.toTile);
        if (!target) continue;
        if (target.type === 'editor') {
          const fileName = path.split(/[\\/]/).pop() || 'file';
          store.updateTile(target.id, {
            filePath: path,
            title: fileName,
          } as Partial<EditorTile>);
          store.bringToFront(target.id);
          routed = true;
        } else if (target.type === 'diff') {
          // Drop the path into the most useful slot for the diff's current
          // mode: git mode → set gitTarget if path lives under repoPath;
          // compare mode → fill the empty side; paste mode → switch to
          // compare mode and seed the modified side.
          const diff = target as DiffTile;
          const mode = diff.mode ?? 'git';
          if (mode === 'git' && diff.repoPath && path.startsWith(diff.repoPath)) {
            const rel = path.slice(diff.repoPath.length).replace(/^[\\/]/, '');
            store.updateTile(target.id, { gitTarget: rel } as Partial<DiffTile>);
          } else if (mode === 'compare') {
            const slot = diff.compareLeft ? 'compareRight' : 'compareLeft';
            store.updateTile(target.id, { [slot]: path } as Partial<DiffTile>);
          } else {
            store.updateTile(target.id, { mode: 'compare', compareRight: path } as Partial<DiffTile>);
          }
          store.bringToFront(target.id);
          routed = true;
        }
        // Pulse the wire briefly for visual feedback
        store.setWireActive(wire.id, true);
        setTimeout(() => useCanvasStore.getState().setWireActive(wire.id, false), 1500);
      }
      if (routed) return;
    }

    // Fallback: open file in an EditorTile — reuse existing match or spawn new
    const existing = allTiles.find(
      (t): t is EditorTile => t.type === 'editor' && (t as EditorTile).filePath === path,
    );

    if (existing) {
      store.bringToFront(existing.id);
    } else {
      const fileName = path.split(/[\\/]/).pop() || 'file';
      store.addTile({
        id: crypto.randomUUID(),
        type: 'editor',
        title: fileName,
        filePath: path,
        language: '',
        x: tile.x + tile.w + 16,
        y: tile.y,
        w: 500,
        h: 400,
      } as Tile);
    }
  }, [tile.id, tile.x, tile.y, tile.w]);

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
        padding: spacing.md,
        color: colors.secondary, ...typography.labelSm,
        textAlign: 'center',
      }}>
        {error}
      </div>
    );
  }

  const expandedPaths = tile.expandedPaths ?? EMPTY_PATHS;

  return (
    <div style={{
      width: '100%', height: '100%',
      overflow: 'auto',
      fontFamily: fonts.mono,
      fontSize: '0.75rem',
      lineHeight: '24px',
      padding: `${spacing.xs} 0`,
    }}>
      {nodes.map(node => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expandedPaths={expandedPaths}
          selectedFile={tile.selectedFile}
          onToggle={handleToggleExpand}
          onSelect={handleSelectFile}
        />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  expandedPaths: string[];
  selectedFile?: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeNode({ node, depth, expandedPaths, selectedFile, onToggle, onSelect }: TreeNodeProps) {
  const isDir = node.node_type === 'Directory';
  const isExpanded = expandedPaths.includes(node.path);
  const isSelected = selectedFile === node.path;

  const handleClick = () => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <>
      <div
        onClick={handleClick}
        style={{
          height: 24,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: depth * 16 + 8,
          paddingRight: 8,
          cursor: 'pointer',
          color: isSelected ? colors.primary : colors.onSurfaceVariant,
          background: isSelected ? alpha(colors.primary, 7) : 'transparent',
          borderRadius: radius.sm,
          userSelect: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        onMouseEnter={e => {
          if (!isSelected) e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 4);
        }}
        onMouseLeave={e => {
          if (!isSelected) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{
          width: 16,
          flexShrink: 0,
          textAlign: 'center',
          color: colors.secondary,
          fontSize: '0.625rem',
        }}>
          {isDir ? (isExpanded ? '\u25BC' : '\u25B6') : ''}
        </span>
        <span style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {node.name}
        </span>
      </div>
      {isDir && isExpanded && node.children?.map(child => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          selectedFile={selectedFile}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
