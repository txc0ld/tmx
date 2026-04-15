import { create } from 'zustand';

/**
 * A reusable prompt that can be dispatched into any Agent tile.
 * Users build their own library over time; we ship ~8 built-ins that
 * cover the most common workflows — code review, test generation, docs,
 * refactor, debug, etc. Built-ins aren't editable; users clone + modify.
 */
export interface AgentPrompt {
  id: string;
  name: string;
  description: string;
  body: string;        // The actual prompt text written to the PTY.
  tags: string[];      // Free-form: 'review', 'tests', 'refactor', …
  icon?: string;       // Optional emoji or short glyph
  isBuiltin: boolean;
}

const STORAGE_KEY = 'tx-prompt-library';

const BUILTIN_PROMPTS: AgentPrompt[] = [
  {
    id: 'builtin:code-review',
    name: 'Code review',
    description: 'Review recently changed files for bugs, style, and obvious issues.',
    body: 'Review the recently modified files in this repo. Call out bugs, style inconsistencies, unused code, and anything that would fail a thorough peer review. Prioritize: correctness > security > readability > style. One concise punchy finding per line.',
    tags: ['review', 'quality'],
    icon: '🔍',
    isBuiltin: true,
  },
  {
    id: 'builtin:test-writer',
    name: 'Write tests',
    description: 'Generate tests for the most recently touched module.',
    body: 'Write unit tests for the most recently changed module in this repo. Cover happy path, edge cases (empty inputs, boundary values, null/undefined), and any failure modes visible from the code. Use the existing test framework and patterns — do not introduce a new one.',
    tags: ['tests'],
    icon: '🧪',
    isBuiltin: true,
  },
  {
    id: 'builtin:doc-writer',
    name: 'Document this',
    description: 'Add concise docstrings / JSDoc / rustdoc to a target file.',
    body: 'Add concise documentation to the target file. Docstrings should explain the WHY (non-obvious constraints, invariants, tradeoffs) — not just restate the code. Max 2-3 lines per docstring. Skip obvious accessors.',
    tags: ['docs'],
    icon: '📝',
    isBuiltin: true,
  },
  {
    id: 'builtin:refactor',
    name: 'Refactor',
    description: 'Small, safe refactor for readability without changing behavior.',
    body: 'Refactor the target module for readability. No behavior changes. Extract clearly-named helpers where a block is reused 3+ times. Split functions over ~50 lines. Keep the public API identical — if you need to change it, stop and ask.',
    tags: ['refactor', 'quality'],
    icon: '🔧',
    isBuiltin: true,
  },
  {
    id: 'builtin:explain',
    name: 'Explain this',
    description: 'Walk through what the target code does at a high level.',
    body: 'Explain what the target code does. Start with a 2-sentence summary. Then walk through the flow step by step. Call out any surprising choices, gotchas, or things a new contributor should know. Skip trivial explanations (what a for-loop does).',
    tags: ['explain', 'onboarding'],
    icon: '💡',
    isBuiltin: true,
  },
  {
    id: 'builtin:debug',
    name: 'Debug',
    description: 'Diagnose a bug from the current error output.',
    body: 'I just hit an error in the connected terminal. Diagnose the root cause from the error output. State the root cause in one sentence, then propose the minimal fix. Do not change the code yet — wait for confirmation.',
    tags: ['debug'],
    icon: '🐛',
    isBuiltin: true,
  },
  {
    id: 'builtin:security',
    name: 'Security review',
    description: 'Audit the recent diff for security issues.',
    body: 'Review the current git diff for security issues: injection vulnerabilities, unsafe deserialization, SSRF, path traversal, missing auth checks, secret leakage, logic bugs that enable privilege escalation. Only report real issues — "could be tightened" suggestions go at the bottom under "Moderate follow-up".',
    tags: ['review', 'security'],
    icon: '🛡️',
    isBuiltin: true,
  },
  {
    id: 'builtin:perf',
    name: 'Performance audit',
    description: 'Find hot-path inefficiencies in a target module.',
    body: 'Audit the target module for performance issues. Focus on: O(n²) loops where O(n) would work, redundant allocations, synchronous IO in hot paths, unnecessary state re-computation. Rank findings by impact (user-visible / dev-only, high/medium/low). No speculative "could be faster" — require specific evidence.',
    tags: ['perf', 'review'],
    icon: '⚡',
    isBuiltin: true,
  },
];

interface PromptLibraryState {
  prompts: AgentPrompt[];
  /** Add or update a user prompt. Returns the prompt id. */
  savePrompt: (prompt: Omit<AgentPrompt, 'id' | 'isBuiltin'> & { id?: string }) => string;
  deletePrompt: (id: string) => void;
  getPrompt: (id: string) => AgentPrompt | undefined;
  /** Reset to built-ins only (drops user prompts). Used by Command Palette. */
  resetToBuiltins: () => void;
}

function loadFromStorage(): AgentPrompt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...BUILTIN_PROMPTS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...BUILTIN_PROMPTS];
    // Merge built-ins + user prompts, deduping by id.
    const userPrompts = (parsed as AgentPrompt[]).filter(p => !p.isBuiltin);
    const byId = new Map<string, AgentPrompt>();
    for (const p of BUILTIN_PROMPTS) byId.set(p.id, p);
    for (const p of userPrompts) byId.set(p.id, p);
    return Array.from(byId.values());
  } catch {
    return [...BUILTIN_PROMPTS];
  }
}

function saveToStorage(prompts: AgentPrompt[]): void {
  try {
    // Only persist user prompts — built-ins rehydrate from code.
    const userPrompts = prompts.filter(p => !p.isBuiltin);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userPrompts));
  } catch {
    // Storage full or blocked — acceptable failure mode.
  }
}

export const usePromptLibraryStore = create<PromptLibraryState>((set, get) => ({
  prompts: loadFromStorage(),

  savePrompt: (partial) => {
    const id = partial.id ?? `user:${crypto.randomUUID()}`;
    const prompt: AgentPrompt = {
      id,
      name: partial.name,
      description: partial.description,
      body: partial.body,
      tags: partial.tags ?? [],
      icon: partial.icon,
      isBuiltin: false,
    };
    set(state => {
      const existing = state.prompts.findIndex(p => p.id === id);
      const next = existing >= 0
        ? state.prompts.map((p, i) => i === existing ? prompt : p)
        : [...state.prompts, prompt];
      saveToStorage(next);
      return { prompts: next };
    });
    return id;
  },

  deletePrompt: (id) => {
    set(state => {
      const target = state.prompts.find(p => p.id === id);
      // Built-ins can't be deleted — silently no-op. Matches template behavior.
      if (!target || target.isBuiltin) return state;
      const next = state.prompts.filter(p => p.id !== id);
      saveToStorage(next);
      return { prompts: next };
    });
  },

  getPrompt: (id) => get().prompts.find(p => p.id === id),

  resetToBuiltins: () => {
    set(() => {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return { prompts: [...BUILTIN_PROMPTS] };
    });
  },
}));

/**
 * Dispatch a prompt into an Agent tile's PTY. Called by the Command
 * Palette and by the Agent tile's Prompts dropdown.
 *
 * Chunks the write so long prompts don't drop bytes on Windows PTY
 * pipes (same 128-byte chunking as task-assign wire dispatch). Submits
 * with a trailing carriage return so the prompt fires immediately.
 */
export async function dispatchPrompt(
  ptyId: string,
  prompt: AgentPrompt,
  writeFn: (id: string, data: string) => Promise<void>,
): Promise<void> {
  const CHUNK = 128;
  const body = prompt.body;
  for (let i = 0; i < body.length; i += CHUNK) {
    await writeFn(ptyId, body.slice(i, i + CHUNK));
    await new Promise(r => setTimeout(r, 50));
  }
  await writeFn(ptyId, '\r');
}
