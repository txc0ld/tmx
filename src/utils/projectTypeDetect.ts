import { readFileTree, type FileTreeNode } from '@/utils/ipc';

/**
 * Best-effort project-type detection from the top-level files of a
 * project cwd. Runs once per project when the user first adds it, so
 * the app can offer a matching starter layout.
 *
 * Deliberately conservative — if we can't pattern-match with confidence,
 * return null and let the user pick manually. A wrong guess is worse
 * than no guess.
 */
export type ProjectKind =
  | 'rust'
  | 'node'
  | 'python'
  | 'go'
  | 'tauri'
  | 'nextjs'
  | 'vite'
  | 'cargo-workspace'
  | 'generic-git';

export interface DetectedProject {
  kind: ProjectKind;
  label: string;
  confidence: 'high' | 'medium';
  /** Tile kinds we recommend spawning, in preferred order. */
  starterTiles: Array<{
    type: 'terminal' | 'runner' | 'agent' | 'git' | 'filetree' | 'editor' | 'browser';
    /** Optional config overrides (e.g. `{ command: 'cargo test' }` for runner). */
    config?: Record<string, unknown>;
  }>;
}

function hasFile(nodes: FileTreeNode[], name: string): boolean {
  return nodes.some(n => n.node_type === 'File' && n.name === name);
}

function hasDir(nodes: FileTreeNode[], name: string): boolean {
  return nodes.some(n => n.node_type === 'Directory' && n.name === name);
}

/**
 * Match order matters — check more specific kinds before generic.
 * Example: Tauri is a superset of Node + Rust, so we check it first.
 */
export async function detectProjectKind(cwd: string): Promise<DetectedProject | null> {
  let nodes: FileTreeNode[];
  try {
    nodes = await readFileTree(cwd, 1);
  } catch {
    return null;
  }

  // Tauri (project has both package.json AND src-tauri/)
  if (hasFile(nodes, 'package.json') && hasDir(nodes, 'src-tauri')) {
    return {
      kind: 'tauri',
      label: 'Tauri app (Node + Rust)',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'agent', config: { agent: 'claude' } },
        { type: 'filetree' },
        { type: 'runner', config: { command: 'pnpm tauri dev' } },
        { type: 'git' },
      ],
    };
  }

  // Next.js
  if (hasFile(nodes, 'next.config.js') || hasFile(nodes, 'next.config.mjs') || hasFile(nodes, 'next.config.ts')) {
    return {
      kind: 'nextjs',
      label: 'Next.js',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'runner', config: { command: 'pnpm dev' } },
        { type: 'browser', config: { url: 'http://localhost:3000' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Vite (but not Tauri — Tauri handled above)
  if (hasFile(nodes, 'vite.config.js') || hasFile(nodes, 'vite.config.ts') || hasFile(nodes, 'vite.config.mjs')) {
    return {
      kind: 'vite',
      label: 'Vite',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'runner', config: { command: 'pnpm dev' } },
        { type: 'browser', config: { url: 'http://localhost:5173' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Cargo workspace (root Cargo.toml + members)
  if (hasFile(nodes, 'Cargo.toml') && hasDir(nodes, 'crates')) {
    return {
      kind: 'cargo-workspace',
      label: 'Rust workspace',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'runner', config: { command: 'cargo test --workspace' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Plain Rust
  if (hasFile(nodes, 'Cargo.toml')) {
    return {
      kind: 'rust',
      label: 'Rust',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'agent', config: { agent: 'claude' } },
        { type: 'runner', config: { command: 'cargo test' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Node / pnpm / npm / yarn project
  if (hasFile(nodes, 'package.json')) {
    return {
      kind: 'node',
      label: 'Node.js',
      confidence: 'medium',
      starterTiles: [
        { type: 'terminal' },
        { type: 'agent', config: { agent: 'claude' } },
        { type: 'runner', config: { command: 'pnpm test' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Python — pyproject, requirements, or setup.py
  if (hasFile(nodes, 'pyproject.toml') || hasFile(nodes, 'requirements.txt') || hasFile(nodes, 'setup.py')) {
    return {
      kind: 'python',
      label: 'Python',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'agent', config: { agent: 'claude' } },
        { type: 'runner', config: { command: 'pytest' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Go module
  if (hasFile(nodes, 'go.mod')) {
    return {
      kind: 'go',
      label: 'Go',
      confidence: 'high',
      starterTiles: [
        { type: 'terminal' },
        { type: 'agent', config: { agent: 'claude' } },
        { type: 'runner', config: { command: 'go test ./...' } },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  // Last resort: if it's a git repo, offer the generic dev layout
  if (hasDir(nodes, '.git')) {
    return {
      kind: 'generic-git',
      label: 'Git repo',
      confidence: 'medium',
      starterTiles: [
        { type: 'terminal' },
        { type: 'filetree' },
        { type: 'git' },
      ],
    };
  }

  return null;
}
