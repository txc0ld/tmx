import { create } from 'zustand';

export interface RecordedEvent {
  timestamp: number; // ms since recording start
  ptyId: string;
  data: string;
}

interface RecordingState {
  isRecording: boolean;
  startTime: number;
  events: RecordedEvent[];
  // Replay state
  isReplaying: boolean;
  replayPosition: number; // ms
  replaySpeed: number;

  startRecording: () => void;
  stopRecording: () => RecordedEvent[];
  recordEvent: (ptyId: string, data: string) => void;

  startReplay: () => void;
  stopReplay: () => void;
  setReplayPosition: (ms: number) => void;
  setReplaySpeed: (speed: number) => void;
  clearRecording: () => void;
}

const MAX_EVENTS = 50000;

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  startTime: 0,
  events: [],
  isReplaying: false,
  replayPosition: 0,
  replaySpeed: 1,

  startRecording: () => set({
    isRecording: true,
    startTime: Date.now(),
    events: [],
  }),

  stopRecording: () => {
    const events = get().events;
    set({ isRecording: false });
    return events;
  },

  recordEvent: (ptyId, data) => {
    const s = get();
    if (!s.isRecording) return;
    if (s.events.length >= MAX_EVENTS) {
      set({ isRecording: false });
      return;
    }
    const timestamp = Date.now() - s.startTime;
    set(ss => ({
      events: [...ss.events, { timestamp, ptyId, data }],
    }));
  },

  startReplay: () => set({ isReplaying: true, replayPosition: 0 }),
  stopReplay: () => set({ isReplaying: false }),
  setReplayPosition: (ms) => set({ replayPosition: ms }),
  setReplaySpeed: (speed) => set({ replaySpeed: speed }),
  clearRecording: () => set({ events: [], replayPosition: 0, isReplaying: false }),
}));
