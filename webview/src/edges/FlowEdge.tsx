import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import type { ViewEdge } from '../filters';
import { useStore } from '../store';
import { edgePaths } from './BallLayer';

export interface FlowEdgeData extends Record<string, unknown> {
  view: ViewEdge;
  locked: boolean;
}

const BIDIRECTIONAL = new Set(['call', 'method_call', 'reference']);

export const FlowEdge = memo(function FlowEdge(props: EdgeProps & { data: FlowEdgeData }) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const { view, locked } = data;
  const first = view.edges[0];
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  edgePaths.set(id, path);
  const hover = useStore(s => s.hover);
  const toggleLock = useStore(s => s.toggleLock);
  const hovered = useStore(s => s.hoverEdge?.id === id);
  const pulsing = useStore(s => view.edges.reduce((m, e) => Math.max(m, s.pulse[e.id] ?? 0), 0));
  const resolved = view.edges.every(e => e.resolved);
  const level = Math.max(...view.edges.map(e => e.level));
  const cls = ['cf-edge', `cf-l${level}`, `cf-k-${first.kind}`, resolved ? '' : 'cf-unresolved',
    first.external ? 'cf-external' : '', selected || hovered ? 'cf-edge-hot' : '', locked ? 'cf-locked' : ''].join(' ');
  const bidi = BIDIRECTIONAL.has(first.kind);
  const label = first.kind === 'depends' || first.label?.startsWith('via ') ? first.label : view.rerouted && view.edges.length > 1 ? `×${view.edges.length}` : null;
  return (
    <>
      <BaseEdge id={id} path={path} className={cls}
        markerEnd="url(#cf-arrow)" markerStart={bidi ? 'url(#cf-arrow-rev)' : undefined}
        interactionWidth={14} />
      {pulsing > 0 && <path key={pulsing} d={path} className="cf-pulse" fill="none" />}
      <path d={path} fill="none" stroke="transparent" strokeWidth={14}
        onMouseEnter={e => hover({ id, x: e.clientX, y: e.clientY })}
        onMouseMove={e => hover({ id, x: e.clientX, y: e.clientY })}
        onMouseLeave={() => hover(null)} />
      <EdgeLabelRenderer>
        <div className="cf-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {label && <span className="cf-edge-text">{label}</span>}
          {(hovered || selected || locked) && !view.rerouted && (
            <button className={`cf-lock ${locked ? 'on' : ''}`} title={locked ? 'Unlock wire' : 'Lock wire visible'}
              onClick={() => toggleLock(first.id)}>{locked ? '🔒' : '🔓'}</button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
