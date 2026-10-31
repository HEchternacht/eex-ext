import type { GraphEdge } from '../../../shared/graph';
import type { ViewEdge } from '../filters';
import { WireValues, useStore } from '../store';

const KIND_TEXT: Record<string, string> = {
  call: 'calls', method_call: 'calls method', reference: 'passes function', decorates: 'decorates',
  depends: 'dependency', global_read: 'reads global', global_write: 'writes global', flow: 'return value flows into',
};

export interface TooltipLine { label: string; type: string; value?: string }

/** Lines shown when hovering a wire: in (args) and out (return). Pure, unit-tested. */
export function tooltipLines(e: GraphEdge, values?: WireValues): TooltipLine[] {
  const lines: TooltipLine[] = [];
  if (e.kind === 'global_read' || e.kind === 'global_write') {
    lines.push({ label: e.label ?? '', type: values?.ret?.type ?? 'unknown', value: values?.ret?.value });
    return lines;
  }
  if (e.args.length || values?.args) {
    const n = Math.max(e.args.length, values?.args?.length ?? 0);
    for (let i = 0; i < n; i++) {
      const s = e.args[i];
      const v = values?.args?.[i];
      lines.push({ label: `in ${v?.name ?? s?.expr ?? i}`, type: v?.type ?? s?.type ?? 'unknown', value: v?.value });
    }
  }
  if (e.kind !== 'decorates') {
    lines.push({ label: 'out', type: values?.ret?.type ?? e.typeOut ?? 'unknown', value: values?.ret?.value });
  }
  return lines;
}

export function WireTooltip({ edges }: { edges: Map<string, ViewEdge> }) {
  const hover = useStore(s => s.hoverEdge);
  const edgeValues = useStore(s => s.edgeValues);
  if (!hover) return null;
  const view = edges.get(hover.id);
  if (!view) return null;
  return (
    <div className="cf-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      {view.edges.slice(0, 4).map(e => (
        <div key={e.id} className="cf-tip-edge">
          <div className="cf-tip-head">
            <b>{shortId(e.source)}</b> {KIND_TEXT[e.kind]} <b>{shortId(e.target === '<imports>' || e.target === '<unresolved>' ? e.targetPort : e.target)}</b>
            <span className="cf-tip-meta"> L{e.level}{e.resolved ? '' : ' · unresolved'}{e.external ? ' · library' : ''}</span>
          </div>
          {e.label && <div className="cf-tip-expr">{e.label}</div>}
          {tooltipLines(e, edgeValues[e.id]).map((l, i) => (
            <div key={i} className="cf-tip-line">
              <span className="cf-tip-label">{l.label}</span>
              <span className="cf-tip-type">{l.type}</span>
              {l.value !== undefined && <span className="cf-tip-value">{l.value}</span>}
            </div>
          ))}
          <div className="cf-tip-meta">{e.sites.slice(0, 3).map(s => `${s.file.replace(/\\/g, '/').split('/').pop()}:${s.line}`).join(', ')}</div>
        </div>
      ))}
      {view.edges.length > 4 && <div className="cf-tip-meta">+{view.edges.length - 4} more</div>}
    </div>
  );
}

function shortId(id: string) {
  return id.split('.').slice(-2).join('.');
}
