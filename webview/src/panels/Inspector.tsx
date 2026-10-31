// Inspector ("visualizer"): everything about the selected node or wire, readable and expandable.
import { useEffect, useMemo, useState } from 'react';
import type { GraphEdge, GraphNode } from '../../../shared/graph';
import type { TracedValue, ValueTree } from '../../../shared/protocol';
import { Icon } from '../nodes/CodeNode';
import { useStore, type WireValues } from '../store';
import { KIND_ICON, typeColor } from '../theme';
import { classIndex, expandType, inferType, parseType, showType } from '../types';
import { TypeTree } from '../values/TypeTree';
import { ValueView } from '../values/ValueView';
import { PausePanel } from './Debug';
import { post } from '../vscode';

type Tab = 'overview' | 'value' | 'type' | 'callers' | 'callees' | 'source' | 'stats';

const tree = (v: TracedValue): ValueTree => v.tree ?? { t: v.type, k: 'other', r: v.value };
const KIND_LABEL: Record<string, string> = {
  call: 'call', method_call: 'method call', reference: 'passed as value', decorates: 'decorates', depends: 'Depends',
  global_read: 'reads global', global_write: 'writes global', flow: 'value flows into',
};

function Values({ values, prefix }: { values?: WireValues; prefix: string }) {
  const runs = values?.history.length ?? 0;
  const [run, setRun] = useState(-1);   // -1 = latest
  const shown = run >= 0 && values?.history[run] ? values.history[run] : values;
  if (!shown?.args && !shown?.ret) return <div className="cf-empty"><Icon name="debug-alt" /> No values yet. Run <b>Trace tests</b> or <b>Trace launch</b> to capture them.</div>;
  return (
    <>
      {runs > 1 && (
        <div className="cf-runs">Run
          <button disabled={run === 0} onClick={() => setRun(r => (r < 0 ? runs - 2 : r - 1))}><Icon name="chevron-left" /></button>
          {run < 0 ? runs : run + 1} of {runs}
          <button disabled={run < 0} onClick={() => setRun(r => (r + 1 >= runs - 1 ? -1 : r + 1))}><Icon name="chevron-right" /></button>
        </div>
      )}
      {shown.args && <div className="cf-insp-sub"><Icon name="arrow-right" /> arguments in</div>}
      {shown.args?.map(a => <ValueView key={a.name} name={a.name} value={tree(a)} path={`${prefix}.args.${a.name}`} />)}
      {shown.ret && <div className="cf-insp-sub"><Icon name="arrow-left" /> return value out</div>}
      {shown.ret && <ValueView name="return" value={tree(shown.ret)} path={`${prefix}.return`} />}
    </>
  );
}

function WireList({ edges, other, graph, onGo }: { edges: GraphEdge[]; other: (e: GraphEdge) => string; graph: Map<string, GraphNode>; onGo: (id: string) => void }) {
  const calls = useStore(s => s.edgeCalls);
  const selectEdge = useStore(s => s.selectEdge);
  if (!edges.length) return <div className="cf-empty">None.</div>;
  return (
    <div>{edges.map(e => {
      const o = graph.get(other(e));
      return (
        <div key={e.id} className="cf-insp-wire" onClick={() => onGo(other(e))} title="Click: go to it">
          <span className={`cf-lvl cf-lvl-${e.level}`}>{e.level}</span>
          <Icon name={o ? KIND_ICON[o.kind] : 'question'} />
          <span className="cf-insp-name">{o?.kind === 'imports' || o?.kind === 'globals' || o?.kind === 'unresolved' ? (e.kind === 'global_write' || e.target === o.id ? e.targetPort : e.sourcePort) : o?.qualname ?? other(e)}</span>
          <span className="cf-insp-kind">{KIND_LABEL[e.kind]}{e.resolved ? '' : ' · unresolved'}</span>
          {calls[e.id] ? <span className="cf-group-count">×{calls[e.id]}</span> : null}
          <button className="cf-v-copy" title="Inspect wire" onClick={ev => { ev.stopPropagation(); selectEdge(e.id); }}><Icon name="inspect" /></button>
        </div>
      );
    })}</div>
  );
}

export function Inspector({ onGo }: { onGo: (id: string) => void }) {
  const graph = useStore(s => s.graph);
  const selected = useStore(s => s.selected);
  const selectedEdge = useStore(s => s.selectedEdge);
  const nodeValues = useStore(s => (selected ? s.nodeValues[selected] : undefined));
  const edgeValues = useStore(s => (selectedEdge ? s.edgeValues[selectedEdge] : undefined));
  const stats = useStore(s => (selected ? s.stats[selected] : undefined));
  const source = useStore(s => (selected ? s.sources[selected] : undefined));
  const setInspector = useStore(s => s.setInspector);
  const [tab, setTab] = useState<Tab>('overview');
  const [width, setWidth] = useState(360);
  const byId = useMemo(() => new Map(graph?.nodes.map(n => [n.id, n]) ?? []), [graph]);
  const classes = useMemo(() => classIndex(graph?.nodes ?? []), [graph]);
  const edge = selectedEdge ? graph?.edges.find(e => e.id === selectedEdge) : undefined;
  const node = !edge && selected ? byId.get(selected) : undefined;
  const callers = useMemo(() => (node ? graph!.edges.filter(e => e.target === node.id) : []), [graph, node]);
  const callees = useMemo(() => (node ? graph!.edges.filter(e => e.source === node.id) : []), [graph, node]);

  useEffect(() => {
    if (tab === 'source' && node?.file && !source) post({ type: 'source', id: node.id });
  }, [tab, node, source]);

  const startResize = (e: React.MouseEvent) => {
    const x0 = e.clientX, w0 = width;
    const move = (ev: MouseEvent) => setWidth(Math.min(720, Math.max(260, w0 + x0 - ev.clientX)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const tabs: [Tab, string, number?][] = edge
    ? [['overview', 'Overview'], ['value', 'Value'], ['type', 'Type']]
    : [['overview', 'Overview'], ['value', 'Value'], ['type', 'Type'], ['callers', 'Callers', callers.length], ['callees', 'Callees', callees.length], ['source', 'Source'], ['stats', 'Stats']];
  const active = tabs.some(t => t[0] === tab) ? tab : 'overview';

  return (
    <aside className="cf-inspector" style={{ width }}>
      <div className="cf-resize" onMouseDown={startResize} />
      <div className="cf-insp-head">
        <Icon name={edge ? 'arrow-swap' : node ? KIND_ICON[node.kind] : 'inspect'} />
        <span className="cf-insp-title">{edge ? `${byId.get(edge.source)?.label ?? edge.source} → ${byId.get(edge.target)?.label ?? edge.target}` : node ? node.label : 'Inspector'}</span>
        {node?.file && <button className="cf-link" title={`Open ${node.file}`} onClick={() => post({ type: 'openNode', id: node.id })}>
          {node.file.replace(/\\/g, '/').split('/').pop()}:{node.range?.def}</button>}
        <button className="cf-icon-btn" title="Close inspector" onClick={() => setInspector(false)}><Icon name="close" /></button>
      </div>
      <PausePanel />
      {!edge && !node ? (
        <div className="cf-empty cf-insp-empty"><Icon name="info" /> Select a node, or right-click a wire → <b>Inspect Wire</b>, to see everything about it: values, types, callers, callees, source.</div>
      ) : (
        <>
          <div className="cf-tabs">{tabs.map(([id, label, n]) => (
            <button key={id} className={active === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{n !== undefined ? <span className="cf-tab-n">{n}</span> : null}</button>
          ))}</div>
          <div className="cf-insp-body">
            {active === 'overview' && node && (
              <div className="cf-insp-overview">
                <div className="cf-kv"><span>kind</span><span><Icon name={KIND_ICON[node.kind]} /> {node.kind}{node.isAsync ? ' · async' : ''}{node.abstract ? ' · abstract' : ''}</span></div>
                <div className="cf-kv"><span>name</span><span className="cf-mono">{node.id}</span></div>
                {node.file && <div className="cf-kv"><span>file</span><span className="cf-mono">{node.file.replace(/\\/g, '/')}:{node.range?.def}</span></div>}
                {node.signature && <pre className="cf-card-sig">{node.signature}</pre>}
                {!!node.decorators?.length && <div className="cf-kv"><span>decorators</span><span>{node.decorators.map(d => <span key={d} className="cf-chip">@{d}</span>)}</span></div>}
                {!!node.bases?.length && <div className="cf-kv"><span>bases</span><span className="cf-mono">{node.bases.join(', ')}</span></div>}
                {node.doc ? <div className="cf-card-doc">{node.doc}</div> : <div className="cf-muted">No docstring.</div>}
                {!!node.fields?.length && (
                  <><div className="cf-insp-sub"><Icon name="symbol-field" /> fields</div>
                    {node.fields.map(f => <div key={f.name} className="cf-kv"><span>{f.name}</span>
                      <span className="cf-mono" style={{ color: typeColor(f.type) }}>{f.type ?? '?'}{f.default ? <span className="cf-muted"> = {f.default}</span> : null}</span></div>)}</>
                )}
              </div>
            )}
            {active === 'overview' && edge && (
              <div className="cf-insp-overview">
                <div className="cf-kv"><span>wire</span><span>{KIND_LABEL[edge.kind]} · level {edge.level}{edge.resolved ? '' : ' · unresolved'}{edge.external ? ' · library' : ''}</span></div>
                <div className="cf-kv"><span>from</span><span className="cf-link" onClick={() => onGo(edge.source)}>{edge.source} · {edge.sourcePort}</span></div>
                <div className="cf-kv"><span>to</span><span className="cf-link" onClick={() => onGo(edge.target)}>{edge.target} · {edge.targetPort}</span></div>
                {edge.label && <div className="cf-kv"><span>label</span><span>{edge.label}</span></div>}
                {edge.args.map((a, i) => <div key={i} className="cf-kv"><span>arg {i}</span><span className="cf-mono">{a.expr} <span style={{ color: typeColor(a.type) }}>{a.type}</span></span></div>)}
                {edge.sites.map((s, i) => <div key={i} className="cf-kv"><span>{i ? '' : 'call site'}</span><span className="cf-mono">{s.file.replace(/\\/g, '/').split('/').pop()}:{s.line}</span></div>)}
              </div>
            )}
            {active === 'value' && <Values values={edge ? edgeValues : nodeValues} prefix={edge?.id ?? node!.id} />}
            {active === 'type' && node && (
              <>
                {node.kind === 'class'
                  ? <TypeTree name={node.label} t={expandType(parseType(node.label), classes)} />
                  : node.ports.filter(p => p.role === 'arg' || p.role === 'return').map(p => {
                    const traced = p.role === 'return' ? nodeValues?.ret : nodeValues?.args?.find(a => a.name === p.name);
                    const seen = traced?.type;
                    const declared = p.type ?? 'unknown';
                    const guess = declared === 'unknown' && traced?.tree;
                    return (
                      <div key={p.id} className="cf-insp-type">
                        <TypeTree name={p.name} t={guess ? expandType(inferType(traced.tree!), classes) : expandType(parseType(declared), classes)} />
                        {seen && <div className={`cf-seen ${declared !== 'unknown' && !showType(parseType(declared)).includes(seen) ? 'cf-mismatch' : ''}`}>
                          observed at runtime: <b style={{ color: typeColor(seen) }}>{seen}</b>{declared === 'unknown' ? ' (best guess from the trace)' : ''}</div>}
                      </div>
                    );
                  })}
              </>
            )}
            {active === 'type' && edge && (
              <>
                <TypeTree name="in" t={expandType(parseType(edge.typeIn ?? 'unknown'), classes)} />
                <TypeTree name="out" t={expandType(parseType(edge.typeOut ?? 'unknown'), classes)} />
              </>
            )}
            {active === 'callers' && <WireList edges={callers} other={e => e.source} graph={byId} onGo={onGo} />}
            {active === 'callees' && <WireList edges={callees} other={e => e.target} graph={byId} onGo={onGo} />}
            {active === 'source' && node && (
              source ? (
                <>
                  <button className="cf-btn" onClick={() => post({ type: 'openNode', id: node.id })}><Icon name="go-to-file" /> Open in editor</button>
                  <pre className="cf-source">{source.text.split('\n').map((l, i) => <div key={i}><span className="cf-ln">{source.start + i}</span>{l}</div>)}</pre>
                </>
              ) : <div className="cf-empty">{node.file ? 'Loading…' : 'No source (library / synthetic node).'}</div>
            )}
            {active === 'stats' && (
              stats ? (
                <div className="cf-insp-overview">
                  <div className="cf-kv"><span>calls</span><span>{stats.calls}</span></div>
                  {stats.lastMs !== undefined && <div className="cf-kv"><span>last duration</span><span>≈ {stats.lastMs.toFixed(1)} ms</span></div>}
                  <div className="cf-kv"><span>last seen</span><span>{new Date(stats.lastTs).toLocaleTimeString()}</span></div>
                  <div className="cf-muted">Durations are approximate: the tracer batches events every <code>trace.flushMs</code>.</div>
                </div>
              ) : <div className="cf-empty"><Icon name="graph" /> Not called in a traced run yet.</div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
