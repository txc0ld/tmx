import { create } from 'zustand';
import { getTimeline, recordEvent as ipcRecordEvent, clearTimeline } from '@/utils/ipc';
import type { TimelineEvent, TimelineEventType } from '@/types';

const EMPTY_EVENTS: TimelineEvent[] = [];

interface TimelineState {
  events: TimelineEvent[];
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  loadEvents: () => Promise<void>;
  recordEvent: (eventType: TimelineEventType, summary: string, detail?: string, tileId?: string) => Promise<void>;
  clear: () => Promise<void>;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  events: EMPTY_EVENTS,
  open: false,

  setOpen: (open) => set({ open }),

  toggle: () => set((s) => ({ open: !s.open })),

  loadEvents: async () => {
    try {
      const events = await getTimeline(200);
      set({ events: events as TimelineEvent[] });
    } catch {
      // Backend may not be available
    }
  },

  recordEvent: async (eventType, summary, detail, tileId) => {
    try {
      const id = await ipcRecordEvent({ eventType, summary, detail, tileId });
      const newEvent: TimelineEvent = {
        id,
        timestamp: new Date().toISOString(),
        eventType: eventType as TimelineEvent['eventType'],
        summary,
        detail,
        tileId,
      };
      set((s) => ({ events: [newEvent, ...s.events] }));
    } catch {
      // Silently fail if backend unavailable
    }
  },

  clear: async () => {
    try {
      await clearTimeline();
      set({ events: EMPTY_EVENTS });
    } catch {
      // Silently fail
    }
  },
}));
