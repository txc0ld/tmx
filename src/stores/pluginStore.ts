import { create } from 'zustand';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  tileType: string; // The tile type identifier this plugin provides
  icon?: string;
  color?: string;
  defaultConfig?: Record<string, unknown>;
  defaultSize?: { w: number; h: number };
}

export interface LoadedPlugin extends PluginManifest {
  enabled: boolean;
  loadedAt: string;
  // Component is rendered via an iframe sandbox for security
  entryUrl?: string;
}

interface PluginState {
  plugins: LoadedPlugin[];
  registerPlugin: (manifest: PluginManifest, entryUrl?: string) => void;
  unregisterPlugin: (id: string) => void;
  togglePlugin: (id: string) => void;
  getPluginForType: (tileType: string) => LoadedPlugin | undefined;
}

function loadPersistedPlugins(): LoadedPlugin[] {
  try {
    const stored = localStorage.getItem('tx-plugins');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function savePlugins(plugins: LoadedPlugin[]) {
  localStorage.setItem('tx-plugins', JSON.stringify(plugins));
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: loadPersistedPlugins(),

  registerPlugin: (manifest, entryUrl) => {
    set(s => {
      // Don't allow duplicate IDs
      if (s.plugins.some(p => p.id === manifest.id)) return s;
      const plugin: LoadedPlugin = {
        ...manifest,
        enabled: true,
        loadedAt: new Date().toISOString(),
        entryUrl,
      };
      const next = [...s.plugins, plugin];
      savePlugins(next);
      return { plugins: next };
    });
  },

  unregisterPlugin: (id) => {
    set(s => {
      const next = s.plugins.filter(p => p.id !== id);
      savePlugins(next);
      return { plugins: next };
    });
  },

  togglePlugin: (id) => {
    set(s => {
      const next = s.plugins.map(p =>
        p.id === id ? { ...p, enabled: !p.enabled } : p,
      );
      savePlugins(next);
      return { plugins: next };
    });
  },

  getPluginForType: (tileType) => {
    return get().plugins.find(p => p.tileType === tileType && p.enabled);
  },
}));
