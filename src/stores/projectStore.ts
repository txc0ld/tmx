import { create } from 'zustand';
import type { Project } from '@/types';
import { useCanvasStore } from './canvasStore';
import {
  loadProjects,
  addProjectToStore,
  updateProjectInStore,
  deleteProjectFromStore,
  gitClone,
} from '@/utils/ipc';

const DEFAULT_PROJECTS: Project[] = [];

interface ProjectState {
  projects: Project[];
  active: string;
  loading: boolean;
  cloning: boolean;

  setActive: (id: string) => void;
  loadFromDisk: () => Promise<void>;
  addProject: (project: Project) => Promise<void>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  cloneFromGithub: (url: string, destPath: string, name: string) => Promise<Project>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: DEFAULT_PROJECTS,
  active: DEFAULT_PROJECTS[0]?.id ?? '',
  loading: false,
  cloning: false,

  setActive: (id: string) => {
    set({ active: id });
    try { localStorage.setItem('tx-active-project', id); } catch { /* non-critical */ }
    if (get().loading) return;
    if (useCanvasStore.getState().activeProject !== id) {
      useCanvasStore.getState().switchProject(id);
    }
  },

  loadFromDisk: async () => {
    set({ loading: true });
    try {
      const saved = await loadProjects();
      if (saved.length > 0) {
        const projects: Project[] = saved.map(p => ({
          id: p.id,
          name: p.name,
          icon: p.icon,
          color: p.color,
          description: p.description,
          cwd: p.cwd,
          gitUrl: p.git_url,
          branch: p.branch,
          webhookUrl: p.webhook_url,
        }));
        // Pick the previously-active project if it's still on disk; otherwise
        // fall back to the first. Use `setActive` so localStorage stays in
        // sync — `mcpStore.getProjectId()` reads from there to load the right
        // per-project connections, and a stale value bleeds tasks across
        // projects.
        const persisted = (() => {
          try { return localStorage.getItem('tx-active-project') ?? ''; } catch { return ''; }
        })();
        const initialActive = projects.find(p => p.id === persisted)?.id ?? projects[0].id;
        set({ projects });
        get().setActive(initialActive);
      }
    } catch {
      // First run with no saved file — start empty; user adds their own via the + button.
    } finally {
      set({ loading: false });
    }
  },

  addProject: async (project: Project) => {
    set(s => ({ projects: [...s.projects, project] }));
    await addProjectToStore(toIpc(project)).catch(console.error);
  },

  updateProject: async (id: string, patch: Partial<Project>) => {
    const prev = get().projects;
    const idx = prev.findIndex(p => p.id === id);
    if (idx === -1) return;
    // Never let `id` be patched — that would corrupt the persisted file's
    // identity invariant. The Rust validator enforces this server-side too.
    const { id: _ignore, ...safePatch } = patch;
    void _ignore;
    const merged: Project = { ...prev[idx], ...safePatch };
    const next = prev.slice();
    next[idx] = merged;
    set({ projects: next });
    try {
      await updateProjectInStore(toIpc(merged));
    } catch (err) {
      // Optimistic rollback on persist failure — same pattern as deleteProject.
      console.error(err);
      set({ projects: prev });
    }
  },

  deleteProject: async (id: string) => {
    const prev = get().projects;
    const prevActive = get().active;
    const next = prev.filter(p => p.id !== id);
    const newActive = prevActive === id && next.length > 0 ? next[0].id : prevActive;
    set({ projects: next });
    // Route through setActive so the localStorage `tx-active-project` key
    // stays in sync with state — see `loadFromDisk` for the same rationale.
    if (prevActive === id && next.length > 0) {
      get().setActive(newActive);
    }
    deleteProjectFromStore(id).catch(() => {
      set({ projects: prev });
      get().setActive(prevActive);
    });
  },

  cloneFromGithub: async (url: string, destPath: string, name: string) => {
    set({ cloning: true });
    try {
      await gitClone(url, destPath);

      const project: Project = {
        id: crypto.randomUUID(),
        name,
        icon: name.charAt(0).toUpperCase(),
        color: '#CCFF00',
        description: `Cloned from ${extractRepoName(url)}`,
        cwd: destPath,
        gitUrl: url,
      };

      await get().addProject(project);
      get().setActive(project.id);
      return project;
    } finally {
      set({ cloning: false });
    }
  },
}));

function toIpc(p: Project) {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon,
    color: p.color,
    description: p.description,
    cwd: p.cwd,
    git_url: p.gitUrl,
    branch: p.branch,
    webhook_url: p.webhookUrl,
  };
}

function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(\.git)?$/);
  return match?.[1] || url;
}
