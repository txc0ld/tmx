import { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';

const MIN_SCALE = 0.1;
const MAX_SCALE = 3.0;
const ZOOM_SENSITIVITY = 0.001;

export function useCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const transformAtPanStart = useRef({ x: 0, y: 0, scale: 1 });

  // Imperative wheel listener (non-passive) for zoom-toward-cursor
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('[data-tile-content]') && !e.altKey) {
        return;
      }

      e.preventDefault();
      const state = useCanvasStore.getState();
      const transform = state.transforms[state.activeProject] || { x: 0, y: 0, scale: 1 };

      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const factor = 1 - e.deltaY * ZOOM_SENSITIVITY;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));

      const scaleRatio = newScale / transform.scale;
      const newX = cursorX - (cursorX - transform.x) * scaleRatio;
      const newY = cursorY - (cursorY - transform.y) * scaleRatio;

      state.setTransform({ x: newX, y: newY, scale: newScale });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const onTile = target.closest?.('[data-tile-shell]');
    const onOverlay = target.closest?.('[data-canvas-overlay]');

    // Pan: left-click on empty canvas, middle-click anywhere, or Alt+left-click anywhere
    // Never pan when clicking on overlay UI (TileDock, Minimap, etc.)
    // Shift+click on empty canvas is reserved for rubber-band selection
    const canPan = !onOverlay && (
      e.button === 1
      || (e.button === 0 && e.altKey)
      || (e.button === 0 && !onTile && !e.shiftKey)
    );

    if (canPan) {
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };

      const state = useCanvasStore.getState();
      const t = state.transforms[state.activeProject] || { x: 0, y: 0, scale: 1 };
      transformAtPanStart.current = { ...t };

      containerRef.current?.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;

    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;

    useCanvasStore.getState().setTransform({
      x: transformAtPanStart.current.x + dx,
      y: transformAtPanStart.current.y + dy,
      scale: transformAtPanStart.current.scale,
    });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      isPanning.current = false;
      containerRef.current?.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    containerRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    isPanning,
  };
}
