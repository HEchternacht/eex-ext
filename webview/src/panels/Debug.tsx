// Intercept panel (paused program: edit arguments, continue, abort) and the inject form (UIX_RESEARCH.md 2.8 / 2.9).
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PauseInfo, TracedValue } from '../../../shared/protocol';
import { Icon } from '../nodes/CodeNode';
import { useStore } from '../store';
import { typeColor } from '../theme';
import { ValueView } from '../values/ValueView';
import { post } from '../vscode';

const tree = (v: TracedValue) => v.tree ?? { t: v.type, k: 'other' as const, r: v.value };

/** The intercept the program is waiting on (first one; others are listed). */
export function PausePanel() {
  const pauses = useStore(useShallow(s => s.pauses.filter(p => p.reason === 'intercept')));
  const answer = useStore(s => s.answerPause);
  const p: PauseInfo | undefined = pauses[0];
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => setEdits({}), [p?.key]);
  if (!p) return null;
  const changed = Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== p.args?.find(a => a.name === k)?.value));
  return (
    <div className="cf-pause">
      <div className="cf-pause-head"><Icon name="debug-pause" /> <b>Paused</b> before <span className="cf-mono">{p.node.split('.').slice(-2).join('.')}</span>
        {p.callers[0] && <span className="cf-muted"> · called by {p.callers[0].split('.').pop()}</span>}
        {pauses.length > 1 && <span className="cf-group-count">+{pauses.length - 1} waiting</span>}</div>
      {p.args?.map(a => (
        <div key={a.name} className="cf-pause-arg">
          <ValueView name={a.name} value={tree(a)} path={`pause.${a.name}`} />
          <input className="cf-expr" disabled={!p.editable} value={edits[a.name] ?? a.value}
            title={p.editable ? 'Python expression, evaluated in the paused function\'s module (other arguments are in scope)' : 'Editing arguments needs Python 3.13+'}
            onChange={e => setEdits(x => ({ ...x, [a.name]: e.target.value }))} />
        </div>
      ))}
      {!p.editable && <div className="cf-muted">Editing arguments needs Python 3.13+; you can still continue or abort.</div>}
      <div className="cf-pause-actions">
        <button className="cf-btn cf-primary" onClick={() => answer(p.key, 'resume')} title="F5"><Icon name="debug-continue" /> Continue</button>
        <button className="cf-btn" disabled={!Object.keys(changed).length} onClick={() => answer(p.key, 'resume', changed)}>
          <Icon name="edit" /> Continue with edits</button>
        <button className="cf-btn cf-danger" onClick={() => answer(p.key, 'abort')} title="Raise codeflow Aborted at this call"><Icon name="debug-stop" /> Abort call</button>
      </div>
    </div>
  );
}

/** Inject form: one Python expression per argument (+ self for methods), live program or a fresh process. */
export function InjectDialog() {
  const id = useStore(s => s.injectFor);
  const graph = useStore(s => s.graph);
  const values = useStore(s => (id ? s.nodeValues[id] : undefined));
  const running = useStore(s => s.traceRunning);
  const results = useStore(useShallow(s => s.injectResults.filter(r => r.node === id)));
  const close = () => useStore.getState().openInject(null);
  const node = useMemo(() => graph?.nodes.find(n => n.id === id), [graph, id]);
  const args = node?.ports.filter(p => p.role === 'arg') ?? [];
  const owner = node?.kind === 'method' || node?.kind === 'property' ? graph?.nodes.find(n => n.id === node.parentId && n.kind === 'class') : undefined;
  const [exprs, setExprs] = useState<Record<string, string>>({});
  const [self, setSelf] = useState('');
  const [target, setTarget] = useState<'auto' | 'fresh'>('auto');
  useEffect(() => {
    setExprs(Object.fromEntries(args.filter(p => p.default !== undefined).map(p => [p.name, p.default!])));
    setSelf(owner ? `${owner.label}()` : '');
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!node) return null;
  const useLast = () => setExprs(Object.fromEntries((values?.args ?? []).map(a => [a.name, a.value])));
  const run = () => {
    const kwargs: Record<string, string> = {};
    for (const p of args) {
      const v = exprs[p.name]?.trim();
      if (v && !p.name.startsWith('*')) kwargs[p.name] = v;
    }
    post({ type: 'inject', request: { node: node.id, args: [], kwargs, self: owner ? self : undefined, target } });
  };
  const last = results.at(-1);
  return (
    <div className="cf-guide-backdrop" onClick={close}>
      <div className="cf-dialog" onClick={e => e.stopPropagation()}>
        <div className="cf-guide-head"><Icon name="zap" /><h2>Inject call · {node.qualname}</h2>
          <button className="cf-icon-btn" onClick={close}><Icon name="close" /></button></div>
        {node.signature && <pre className="cf-card-sig">{node.signature}</pre>}
        <p className="cf-muted">Each field is a Python expression, evaluated in <span className="cf-mono">{node.module}</span>. Leave a field empty to use the default.</p>
        {owner && (
          <label className="cf-inject-row"><span className="cf-v-key">self</span>
            <span className="cf-v-badge" style={{ color: typeColor(owner.label) }}>{owner.label}</span>
            <input className="cf-expr" value={self} onChange={e => setSelf(e.target.value)} placeholder={`${owner.label}(...)`} /></label>
        )}
        {args.map(p => (
          <label key={p.id} className="cf-inject-row"><span className="cf-v-key">{p.name}</span>
            <span className="cf-v-badge" style={{ color: typeColor(p.type) }}>{p.type}</span>
            <input className="cf-expr" value={exprs[p.name] ?? ''}
              placeholder={p.name.startsWith('*') ? 'not supported (left empty)' : p.default !== undefined ? `default: ${p.default}` : 'required'}
              disabled={p.name.startsWith('*')} onChange={e => setExprs(x => ({ ...x, [p.name]: e.target.value }))} /></label>
        ))}
        <div className="cf-inject-target">
          <label><input type="radio" checked={target === 'auto'} onChange={() => setTarget('auto')} /> running program{running ? '' : ' (none running: a fresh one)'}</label>
          <label><input type="radio" checked={target === 'fresh'} onChange={() => setTarget('fresh')} /> fresh process</label>
        </div>
        <div className="cf-pause-actions">
          <button className="cf-btn cf-primary" onClick={run}><Icon name="play" /> Inject</button>
          <button className="cf-btn" disabled={!values?.args} onClick={useLast} title="Fill in the arguments of the last traced call"><Icon name="history" /> Use last traced args</button>
        </div>
        {last && (
          <div className="cf-inject-result">
            <div className="cf-insp-sub"><Icon name={last.ok ? 'pass' : 'error'} /> result · {last.where}</div>
            {last.ok && last.value ? <ValueView name="return" value={tree(last.value)} path={`inject.${node.id}`} />
              : <pre className="cf-v-err cf-tb">{last.error}{'\n'}{last.traceback}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
