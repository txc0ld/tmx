import { useState, useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import type { Wire, WireType } from '@/types';

interface WireStart {
  tileId: string;
  port: string;
}

export function useWiring() {
  const [isWiring, setIsWiring] = useState(false);
  const [wireStart, setWireStart] = useState<WireStart | null>(null);
  const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);

  const startWiring = useCallback((tileId: string, port: string) => {
    setWireStart({ tileId, port });
    setIsWiring(true);
  }, []);

  const endWiring = useCallback((tileId: string, port: string) => {
    if (!wireStart || wireStart.tileId === tileId) {
      cancelWiring();
      return;
    }

    const wire: Wire = {
      id: crypto.randomUUID(),
      fromTile: wireStart.tileId,
      fromPort: wireStart.port as Wire['fromPort'],
      toTile: tileId,
      toPort: port as Wire['toPort'],
      wireType: 'context-pipe' as WireType,
      active: false,
    };

    useCanvasStore.getState().addWire(wire);
    cancelWiring();
  }, [wireStart]);

  const cancelWiring = useCallback(() => {
    setIsWiring(false);
    setWireStart(null);
    setCursorPosition(null);
  }, []);

  // Track cursor during wiring
  useEffect(() => {
    if (!isWiring) return;

    const handleMove = (e: PointerEvent) => {
      setCursorPosition({ x: e.clientX, y: e.clientY });
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelWiring();
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isWiring, cancelWiring]);

  return { isWiring, wireStart, cursorPosition, startWiring, endWiring, cancelWiring };
}
