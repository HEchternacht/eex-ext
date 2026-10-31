// Footer log (UIX_RESEARCH.md 2.11): windowed rows, indent by call depth, filter, kind toggles, auto-scroll.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../nodes/CodeNode';
import { useStore, type LogEntry } from '../store';
import { post } from '../vscode';

const ROW = 22;
const KINDS: { kind: LogEntry['kind']; icon: string; label: string }[] = [
  { kind: 'call', icon: 'debug-step-into', label: 'calls' },
  { kind: 'return', icon: 'debug-step-out', label: 'returns' },
  { kind: 'global', icon: 'symbol-variable', label: 'globals' },
  { kind: 'pause', icon: 'debug-pause', label: 'pauses' },
  { kind: 'inject', icon: 'zap', label: 'injects' },
  { kind: 'error', icon: 'error', label: 'errors' },
  { kind: 'info', icon: 'info', label: 'analysis' },
];
const ICON = Object.fromEntries(KINDS.map(k => [k.kind, k.icon]));

/** Filter syntax: words must all match; `!word` excludes; `node:Master` matches the node id. */
export function logMatches(e: LogEntry, q: string): boolean {
  const hay = `${e.node ?? ''} ${e.caller ?? ''} ${e.text}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t =>
    t.startsWith('!') ? !hay.includes(t.slice(1)) : t.startsWith('node:') ? (e.node ?? '').toLowerCase().includes(t.slice(5)) : hay.includes(t));
}

const time = (ts: number) => {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export function LogPanel({ onGo }: { onGo: (id: string) => void }) {
  const log = useStore(s => s.log);
  const clearLog = useStore(s => s.clearLog);
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(180);
  const [q, setQ] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(true);
  const [scroll, setScroll] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const showHiddenSetting = useStore(s => s.settings.logShowHidden);
  const [showHidden, setShowHidden] = useState(showHiddenSetting);
  useEffect(() => setShowHidden(showHiddenSetting), [showHiddenSetting]);
  const visibleIds = useStore(s => s.visibleIds);
  const shown = useMemo(() => new Set(visibleIds), [visibleIds]);
  // a node inside a collapsed frame counts as shown (the frame is)
  const onCanvas = (id: string) => id.split('.').some((_, i, p) => shown.has(p.slice(0, i + 1).join('.')));
  const rows = useMemo(() => log.filter(e => !off.has(e.kind) && (showHidden || !e.node || onCanvas(e.node)) && (!q.trim() || logMatches(e, q))),
    [log, off, q, showHidden, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = useMemo(() => log.filter(e => e.kind === 'error').length, [log]);

  useEffect(() => {
    if (auto && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [rows, auto, open]);

  const startResize = (e: React.MouseEvent) => {
    const y0 = e.clientY, h0 = height;
    const move = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight * 0.7, Math.max(80, h0 + y0 - ev.clientY)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const toggleKind = (k: string) => setOff(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const viewH = height - 28;
  const first = Math.max(0, Math.floor(scroll / ROW) - 10);
  const last = Math.min(rows.length, first + Math.ceil(viewH / ROW) + 20);

  return (
    <footer className="cf-log" style={{ height: open ? height : 26 }}>
      {open && <div className="cf-log-resize" onMouseDown={startResize} />}
      <div className="cf-log-head">
        <button className="cf-icon-btn" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          <Icon name={open ? 'chevron-down' : 'chevron-up'} /></button>
        <b>LOG</b>
        <span className="cf-group-count">{log.length}</span>
        {errors > 0 && <span className="cf-log-err"><Icon name="error" /> {errors}</span>}
        {open && <>
          <span className="cf-search cf-log-filter"><Icon name="filter" />
            <input placeholder="Filter (text, !exclude, node:Master)" value={q} onChange={e => setQ(e.target.value)} /></span>
          {KINDS.map(k => (
            <button key={k.kind} className={`cf-icon-btn cf-toggle ${off.has(k.kind) ? '' : 'on'}`} title={`${off.has(k.kind) ? 'Show' : 'Hide'} ${k.label}`}
              onClick={() => toggleKind(k.kind)}><Icon name={k.icon} /></button>
          ))}
          <button className={`cf-icon-btn cf-toggle ${showHidden ? 'on' : ''}`} onClick={() => setShowHidden(!showHidden)}
            title={showHidden ? 'Showing calls of hidden nodes too (click: only what the canvas shows)' : 'Only calls of nodes the canvas shows (click: show hidden ones too)'}>
            <Icon name={showHidden ? 'eye' : 'eye-closed'} /></button>
          <span className="cf-log-spacer" />
          <button className={`cf-icon-btn cf-toggle ${auto ? 'on' : ''}`} title="Auto-scroll" onClick={() => setAuto(!auto)}><Icon name={auto ? 'lock' : 'unlock'} /></button>
          <button className="cf-icon-btn" title="Copy shown entries" onClick={() => void navigator.clipboard?.writeText(rows.map(e =>
            `${time(e.ts)}\t${e.kind}\t${e.node ?? ''}\t${e.caller ?? ''}\t${e.text}${e.ms !== undefined ? `\t${e.ms.toFixed(1)} ms` : ''}`).join('\n'))}>
            <Icon name="copy" /></button>
          <button className="cf-icon-btn" title="Clear" onClick={clearLog}><Icon name="clear-all" /></button>
        </>}
      </div>
      {open && (
        <div className="cf-log-body" ref={body} onScroll={e => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW;
          if (atEnd !== auto) setAuto(atEnd);
        }}>
          {!rows.length && <div className="cf-empty">{log.length ? 'No entries match the filter.' : 'Calls, returns, pauses and analysis messages appear here while you trace.'}</div>}
          <div style={{ height: rows.length * ROW, position: 'relative' }}>
            {rows.slice(first, last).map((e, i) => (
              <div key={e.seq} className={`cf-log-row cf-log-${e.kind}`} style={{ top: (first + i) * ROW }}
                onClick={() => e.node && onGo(e.node)} onDoubleClick={() => e.node && post({ type: 'openNode', id: e.node })}>
                <span className="cf-log-time">{time(e.ts)}</span>
                <Icon name={ICON[e.kind]} />
                <span className="cf-log-node" style={{ paddingLeft: Math.min(e.depth, 8) * 10 }}>{e.node ? e.node.split('.').slice(-2).join('.') : ''}</span>
                <span className="cf-log-caller">{e.caller ? e.caller.split('.').slice(-2).join('.') : ''}</span>
                <span className="cf-log-text" title={e.text}>{e.text}</span>
                <span className="cf-log-ms">{e.ms !== undefined ? `${e.ms.toFixed(1)} ms` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </footer>
  );
}
