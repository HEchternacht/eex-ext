// "Ball" animation (UIX_RESEARCH.md 2.5): one SVG overlay, one rAF loop, positions via getPointAtLength.
// A call ball travels caller -> callee; the return ball (a ring) travels back. Balls on a busy wire coalesce (×n).
import { ViewportPortal, useStore as useFlowStore } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/** View edge id -> current SVG path (flow coordinates), registered by FlowEdge on render. */
export const edgePaths = new Map<string, string>();

interface Ball {
  key: string;            // view edge + direction: one ball in flight per key
  path: SVGPathElement;
  len: number;
  start: number;
  dur: number;
  forward: boolean;
  ret: boolean;
  level: number;
  count: number;
  el?: SVGGElement;
}

const SVG = 'http://www.w3.org/2000/svg';
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Duration: constant speed (1.2 px/ms) clamped to 220..700 ms; follow mode uses a fixed, eased step. */
export function ballDuration(len: number, stepMs?: number) {
  return stepMs ?? Math.min(700, Math.max(220, len / 1.2));
}

export function BallLayer({ toView, stepMs }: { toView: Map<string, string>; stepMs?: number }) {
  const layer = useRef<SVGGElement>(null);
  const balls = useRef(new Map<string, Ball>());
  const seen = useRef(0);
  const zoom = useFlowStore(s => s.transform[2]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // spawn balls for new trace steps
  useEffect(() => useStore.subscribe(s => {
    const queue = s.ballQueue;
    const fresh = queue.filter(b => b.seq > seen.current);
    if (!fresh.length) return;
    seen.current = queue[queue.length - 1].seq;
    if (reducedMotion()) return;
    const max = s.settings.maxBalls;
    const graph = s.graph;
    for (const b of fresh) {
      const viewId = toView.get(b.edge);
      const d = viewId && edgePaths.get(viewId);
      const e = graph?.edges.find(x => x.id === b.edge);
      if (!d || !e) continue;
      // Depends wires are drawn provider -> consumer, but the call goes consumer -> provider
      const forward = (b.t === 'call') !== (e.kind === 'depends');
      const key = `${viewId}|${b.t}`;
      const cur = balls.current.get(key);
      if (cur) { cur.count++; continue; }
      if (balls.current.size >= max) continue;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      const len = path.getTotalLength();
      balls.current.set(key, { key, path, len, start: performance.now(), dur: ballDuration(len, b.stepMs ?? stepMs), forward, ret: b.t === 'return', level: e.level, count: 1 });
    }
  }), [toView, stepMs]);

  // one animation loop for every ball
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const g = layer.current;
      if (g) {
        const z = zoomRef.current || 1;
        const r = Math.max(4, 3 / z);
        for (const b of balls.current.values()) {
          const t = Math.min(1, (now - b.start) / b.dur);
          if (!b.el) {
            b.el = document.createElementNS(SVG, 'g');
            b.el.setAttribute('class', `cf-ball cf-ball-l${b.level} ${b.ret ? 'cf-ball-ret' : ''}`);
            b.el.innerHTML = '<circle class="cf-ball-glow"/><circle class="cf-ball-tail2"/><circle class="cf-ball-tail1"/><circle class="cf-ball-core"/><text class="cf-ball-n"/>';
            g.appendChild(b.el);
          }
          const at = (p: number) => b.path.getPointAtLength(b.len * (b.forward ? p : 1 - p));
          const k = stepMs ? ease(t) : t;
          const pos = at(k);
          const [glow, tail2, tail1, core, text] = b.el.children as unknown as SVGElement[];
          const place = (c: SVGElement, p: DOMPoint, rad: number) => {
            c.setAttribute('cx', String(p.x));
            c.setAttribute('cy', String(p.y));
            c.setAttribute('r', String(rad));
          };
          place(glow, pos, r * 2.5);
          place(core, pos, r);
          const lag = (ms: number) => at(Math.max(0, k - ms / b.dur));
          place(tail1, lag(30), r * 0.8);
          place(tail2, lag(60), r * 0.6);
          text.setAttribute('x', String(pos.x + r * 1.6));
          text.setAttribute('y', String(pos.y - r * 1.2));
          text.setAttribute('font-size', String(Math.max(9, 10 / z)));
          text.textContent = b.count > 1 ? `×${b.count}` : '';
          if (t >= 1) {
            b.el.remove();
            balls.current.delete(b.key);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stepMs]);

  return (
    <ViewportPortal>
      <svg className="cf-ball-layer" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', width: 1, height: 1, pointerEvents: 'none' }}>
        <g ref={layer} />
      </svg>
    </ViewportPortal>
  );
}
