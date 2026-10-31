import { useEffect, useRef, useState } from 'react';
import type { GraphNode } from '../../../shared/graph';
import { Icon } from '../nodes/CodeNode';
import { KIND_ICON } from '../theme';

const DELAY_MS = 500;

/** Hover card for a node: full path, file:line, signature, docstring (first 6 lines). */
export function NodeCard({ node, x, y }: { node: GraphNode; x: number; y: number }) {
  const doc = node.doc?.split('\n').slice(0, 6).join('\n');
  const where = node.file ? `${node.file.replace(/\\/g, '/')}${node.range ? `:${node.range.def}` : ''}` : null;
  return (
    <div className="cf-tooltip cf-card" style={{ left: x + 14, top: y + 14 }}>
      <div className="cf-card-head"><Icon name={KIND_ICON[node.kind]} /> <b>{node.kind === 'module' ? node.id : node.qualname}</b>
        <span className="cf-tip-meta"> {node.kind}{node.module && node.kind !== 'module' ? ` · ${node.module}` : ''}</span></div>
      {where && <div className="cf-tip-meta">{where}</div>}
      {node.signature && <pre className="cf-card-sig">{node.signature}</pre>}
      {doc && <div className="cf-card-doc">{doc}</div>}
    </div>
  );
}

/** Delayed hover state: call `enter` on mouse enter, `leave` on mouse leave. */
export function useDelayedHover() {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    hover,
    enter(id: string, x: number, y: number) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setHover({ id, x, y }), DELAY_MS);
    },
    leave() {
      clearTimeout(timer.current);
      setHover(null);
    },
  };
}
