import { create } from 'zustand';
import type { Project } from '@/types';
import { useCanvasStore } from './canvasStore';
import { loadProjects, saveProjects, addProjectToStore, deleteProjectFromStore, gitClone } from '@/utils/ipc';

const DEFAULT_PROJECTS: Project[] = [
  { id: 'findable', name: 'FINDABLE', icon: 'F', color: '#CCFF00', description: 'AI Commerce Scanner', cwd: '~/Projects/findable' },
  { id: 'agnt', name: '.agnt', icon: 'A', color: '#CCFF00', description: 'On-chain Agent Identity', cwd: '~/Projects/agnt-protocol' },
  { id: 'raven', name: 'Raven', icon: 'R', color: '#CCFF00', description: 'Multi-Agent Swarm', cwd: '~/Projects/raven' },
  { id: 'warpath', name: 'War Path', icon: 'W', color: '#CCFF00', description: 'NFT Battle Game', cwd: '~/Projects/warpath' },
  { id: 'openclaw', name: 'OpenClaw', icon: 'O', color: '#CCFF00', description: 'Agent Infrastructure', cwd: '~/Projects/openclaw' },
];

interface ProjectState {
  projects: Project[];
  active: string;
  loading: boolean;
  cloning: boolean;

  setActive: (id: string) => void;
  loadFromDisk: () => Promise<void>;
  addProject: (project: Project) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  cloneFromGithub: (url: string, destPath: string, name: string) => Promise<Project>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: DEFAULT_PROJECTS,
  active: DEFAULT_PROJECTS[0].id,
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
        }));
        set({ projects, active: projects[0].id });
        useCanvasStore.getState().switchProject(projects[0].id);
      }
    } catch {
      // First run — use defaults and save them
      const { projects } = get();
      await saveProjects(projects.map(toIpc)).catch(() => {});
    } finally {
      set({ loading: false });
    }
  },

  addProject: async (project: Project) => {
    set(s => ({ projects: [...s.projects, project] }));
    await addProjectToStore(toIpc(project)).catch(console.error);
  },

  deleteProject: async (id: string) => {
    const prev = get().projects;
    const prevActive = get().active;
    const next = prev.filter(p => p.id !== id);
    const newActive = prevActive === id && next.length > 0 ? next[0].id : prevActive;
    set({ projects: next, active: newActive });
    if (prevActive === id && next.length > 0) {
      useCanvasStore.getState().switchProject(newActive);
    }
    deleteProjectFromStore(id).catch(() => {
      set({ projects: prev, active: prevActive });
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
  };
}

function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(\.git)?$/);
  return match?.[1] || url;
}
