import { create } from 'zustand';

interface AgentMemoryState {
  // projectId -> context string
  memories: Record<string, string>;
  getMemory: (projectId: string) => string;
  setMemory: (projectId: string, context: string) => void;
}

function loadMemories(): Record<string, string> {
  try {
    const stored = localStorage.getItem('tx-agent-memories');
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveMemories(memories: Record<string, string>) {
  localStorage.setItem('tx-agent-memories', JSON.stringify(memories));
}

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  memories: loadMemories(),

  getMemory: (projectId) => get().memories[projectId] || '',

  setMemory: (projectId, context) => {
    set(s => {
      const next = { ...s.memories, [projectId]: context };
      saveMemories(next);
      return { memories: next };
    });
  },
}));
