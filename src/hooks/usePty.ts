import { useEffect, useRef, useCallback } from 'react';
import { ptyWrite, ptyResize, ptyKill, onPtyOutput, onPtyExit } from '@/utils/ipc';
import { useCanvasStore } from '@/stores/canvasStore';
import { useRecordingStore } from '@/stores/recordingStore';

interface UsePtyReturn {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export function usePty(
  ptyId: string | undefined,
  onData?: (data: string) => void,
  onExit?: () => void,
): UsePtyReturn {
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  onDataRef.current = onData;
  onExitRef.current = onExit;

  // Subscribe to PTY output
  useEffect(() => {
    if (!ptyId) return;

    let mounted = true;
    let cleanupOutput: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    onPtyOutput(({ id, data }) => {
      if (!mounted || id !== ptyId) return;
      onDataRef.current?.(data);
      useCanvasStore.getState().appendWireData(ptyId, data);
      useRecordingStore.getState().recordEvent(ptyId, data);
    }).then(fn => { if (mounted) cleanupOutput = fn; else fn(); });

    onPtyExit((id) => {
      if (!mounted || id !== ptyId) return;
      onExitRef.current?.();
    }).then(fn => { if (mounted) cleanupExit = fn; else fn(); });

    return () => {
      mounted = false;
      cleanupOutput?.();
      cleanupExit?.();
    };
  }, [ptyId]);

  const write = useCallback((data: string) => {
    if (!ptyId) return;
    ptyWrite(ptyId, data).catch(console.error);
    // Detect user pressing Enter (carriage return) — marks that a command
    // was submitted. Auto-pipe uses this as the trigger instead of raw idle,
    // so it only fires after you've actually run something.
    if (data.includes('\r') || data.includes('\n')) {
      useCanvasStore.getState().markCommandSubmitted(ptyId);
    }
  }, [ptyId]);

  const resize = useCallback((cols: number, rows: number) => {
    if (ptyId) ptyResize(ptyId, cols, rows).catch(console.error);
  }, [ptyId]);

  const kill = useCallback(() => {
    if (ptyId) ptyKill(ptyId).catch(console.error);
  }, [ptyId]);

  return { write, resize, kill };
}
