// Follow mode and intercept handling: the traced program waits on each pause until the canvas answers.
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import type { PauseInfo } from '../../shared/protocol';
import { edgeIndex, useStore } from './store';

const st = useStore.getState;

/** Graph edge a step travels on: the first caller in the chain with a static wire to the node. */
export function stepEdge(p: PauseInfo): string | undefined {
  const g = st().graph;
  if (!g) return undefined;
  const index = edgeIndex(g.edges);
  for (const c of p.callers) {
    const ids = index.get(`${c}>${p.node}`);
    if (ids?.length) return ids[0];
  }
  return undefined;
}

export function useTraceDriver() {
  const rf = useReactFlow();
  const busy = useRef<string | null>(null);   // key of the follow step being animated

  /** Pan (and zoom for panZoom) to a node unless it already sits in the central 60 % of the view. */
  const camera = (id: string, ms: number, force = false) => {
    const mode = st().settings.followCamera;
    if (mode === 'off' && !force) return;
    const n = rf.getInternalNode(id);
    if (!n) return;
    const w = n.measured.width ?? 0, h = Math.min(n.measured.height ?? 0, 200);
    const cx = n.internals.positionAbsolute.x + w / 2, cy = n.internals.positionAbsolute.y + h / 2;
    const { x, y, zoom } = rf.getViewport();
    const el = document.querySelector('.react-flow') as HTMLElement | null;
    const W = el?.clientWidth ?? 800, H = el?.clientHeight ?? 600;
    const sx = cx * zoom + x, sy = cy * zoom + y;
    const inside = sx > W * 0.2 && sx < W * 0.8 && sy > H * 0.2 && sy < H * 0.8;
    const targetZoom = mode === 'panZoom' || force ? Math.max(zoom, 0.9) : zoom;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!inside || targetZoom !== zoom) void rf.setCenter(cx, cy, { zoom: targetZoom, duration: reduced ? 0 : Math.min(450, ms) });
  };

  useEffect(() => {
    const run = () => {
      const s = st();
      if (busy.current) return;
      const next = s.pauses.find(p => p.reason === 'follow');
      if (!next || s.followHold) return;
      busy.current = next.key;
      const ms = s.followStepMs ?? s.settings.followStepMs;
      const edge = stepEdge(next);
      if (edge) {
        const seq = (s.ballQueue.at(-1)?.seq ?? 0) + 1;
        useStore.setState(x => ({ ballQueue: [...x.ballQueue, { seq, edge, t: next.t, stepMs: ms }].slice(-200) }));
      }
      camera(next.t === 'call' ? next.node : next.callers[0] ?? next.node, ms);
      useStore.setState(x => ({ glow: { ...x.glow, [next.node]: performance.now() } }));
      setTimeout(() => {
        busy.current = null;
        // the user may have held follow meanwhile: the step stays queued until Resume / Step
        if (!st().followHold && st().pauses.some(p => p.key === next.key)) st().answerPause(next.key, 'resume');
        run();
      }, ms);
    };
    let seen = new Set<string>();
    return useStore.subscribe(s => {
      // intercepts: bring the node into view and open the inspector (once per pause)
      for (const p of s.pauses) {
        if (p.reason === 'intercept' && !seen.has(p.key)) {
          camera(p.node, 400, true);
          if (!s.inspector) st().setInspector(true);
        }
      }
      seen = new Set(s.pauses.map(p => p.key));
      run();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Step: acknowledge one held follow step. */
  return {
    step() {
      const p = st().pauses.find(x => x.reason === 'follow');
      if (p) st().answerPause(p.key, 'resume');
    },
  };
}
