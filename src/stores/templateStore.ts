import { create } from 'zustand';
import type { TileType, PipelineRole, RoleCapabilities, WireType } from '@/types';

export interface TileTemplate {
  id: string;
  name: string;
  category: TileType;
  description?: string;
  config: Record<string, unknown>;
  isBuiltin: boolean;
}

export interface PipelineTileSpec {
  role: PipelineRole;
  type: TileType;
  position: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
}

export interface PipelineWireSpec {
  fromRole: PipelineRole;
  toRole: PipelineRole;
  wireType: WireType;
}

export interface PipelineConfig {
  retryBudget: { reviewerReject: number; ciFail: number; planReject: number };
  dualReviewer: boolean;
  requireMergeGate: boolean;
  skillBindings: Partial<Record<PipelineRole, string[]>>;
  testCommand?: string;
  capabilities?: Partial<Record<PipelineRole, RoleCapabilities>>;
}

export interface PipelineTemplate {
  kind: 'pipeline';
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;
  tiles: PipelineTileSpec[];
  wires: PipelineWireSpec[];
  pipeline: PipelineConfig;
}

export type AnyTemplate = TileTemplate | PipelineTemplate;

export function isPipelineTemplate(t: AnyTemplate): t is PipelineTemplate {
  return (t as { kind?: string }).kind === 'pipeline';
}

const BUILTIN_TEMPLATES: TileTemplate[] = [
  // Agent templates
  { id: 'claude-opus', name: 'Claude (Opus 4)', category: 'agent', description: 'High-effort reasoning', config: { agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code' }, isBuiltin: true },
  { id: 'claude-sonnet', name: 'Claude (Sonnet)', category: 'agent', description: 'Fast balanced', config: { agent: 'claude', model: 'sonnet-4', effort: 'low', mode: 'code' }, isBuiltin: true },
  { id: 'codex-agent', name: 'Codex', category: 'agent', description: 'OpenAI Codex CLI', config: { agent: 'codex', model: 'codex', effort: '', mode: '' }, isBuiltin: true },
  { id: 'gemini-agent', name: 'Gemini', category: 'agent', description: 'Google Gemini CLI', config: { agent: 'gemini', model: 'gemini', effort: '', mode: '' }, isBuiltin: true },

  // Terminal templates
  { id: 'terminal-home', name: 'Terminal', category: 'terminal', description: 'Shell at home', config: { cwd: '~' }, isBuiltin: true },
  { id: 'terminal-project', name: 'Terminal (Project)', category: 'terminal', description: 'Shell at project root', config: {}, isBuiltin: true },

  // Content templates
  { id: 'note', name: 'Quick Note', category: 'note', config: { content: '' }, isBuiltin: true },
  { id: 'todo', name: 'Todo List', category: 'todo', config: { items: [] }, isBuiltin: true },
  { id: 'browser-3000', name: 'Browser :3000', category: 'browser', description: 'localhost:3000', config: { url: 'http://localhost:3000' }, isBuiltin: true },
  { id: 'browser-5173', name: 'Browser :5173', category: 'browser', description: 'localhost:5173', config: { url: 'http://localhost:5173' }, isBuiltin: true },

  // File tree
  { id: 'filetree', name: 'File Tree', category: 'filetree', config: { rootPath: '~' }, isBuiltin: true },

  // Runner templates
  { id: 'runner-npm-test', name: 'npm test', category: 'runner', description: 'Run npm test', config: { command: 'npm test', cwd: '~' }, isBuiltin: true },
  { id: 'runner-npm-build', name: 'npm run build', category: 'runner', description: 'Run npm build', config: { command: 'npm run build', cwd: '~' }, isBuiltin: true },
  { id: 'runner-cargo-test', name: 'cargo test', category: 'runner', description: 'Run cargo test', config: { command: 'cargo test', cwd: '~' }, isBuiltin: true },
  { id: 'runner-cargo-build', name: 'cargo build', category: 'runner', description: 'Run cargo build', config: { command: 'cargo build', cwd: '~' }, isBuiltin: true },

  // SSH & Docker
  { id: 'ssh-terminal', name: 'SSH Terminal', category: 'ssh', description: 'Remote SSH connection', config: { host: '', port: 22, user: '', connected: false }, isBuiltin: true },
  { id: 'docker-containers', name: 'Docker', category: 'docker', description: 'Container management', config: { containers: [] }, isBuiltin: true },
];

interface TemplateState {
  templates: TileTemplate[];
  addTemplate: (template: TileTemplate) => void;
  removeTemplate: (id: string) => void;
}

function loadUserTemplates(): TileTemplate[] {
  try {
    const stored = localStorage.getItem('tx-templates');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveUserTemplates(templates: TileTemplate[]) {
  const userOnly = templates.filter(t => !t.isBuiltin);
  localStorage.setItem('tx-templates', JSON.stringify(userOnly));
}

export const useTemplateStore = create<TemplateState>((set) => ({
  templates: [...BUILTIN_TEMPLATES, ...loadUserTemplates()],

  addTemplate: (template) => {
    set(s => {
      const next = [...s.templates, template];
      saveUserTemplates(next);
      return { templates: next };
    });
  },

  removeTemplate: (id) => {
    set(s => {
      const next = s.templates.filter(t => t.id !== id);
      saveUserTemplates(next);
      return { templates: next };
    });
  },
}));
