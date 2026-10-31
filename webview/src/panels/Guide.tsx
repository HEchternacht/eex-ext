// Legend chip (live swatches, click to filter) and the one-page guide (UIX_RESEARCH.md 2.14).
import { useState, type ReactNode } from 'react';
import { Icon } from '../nodes/CodeNode';
import { useStore } from '../store';
import type { TypeKind } from '../theme';

const Wire = ({ cls, w = 44 }: { cls: string; w?: number }) => (
  <svg width={w} height={10} className="cf-swatch"><path d={`M2 5 L${w - 2} 5`} className={`cf-edge ${cls}`} /></svg>
);

const Port = ({ shape, color }: { shape: string; color?: string }) => (
  <span className="cf-port-swatch"><span className={`react-flow__handle cf-handle cf-shape-${shape}`} style={{ color: color ?? 'var(--cf-node-title)' }} /></span>
);

const TYPES: [TypeKind, string][] = [
  ['int', 'int'], ['float', 'float'], ['bool', 'bool'], ['str', 'str'], ['bytes', 'bytes'], ['none', 'None'], ['list', 'list / tuple / set'],
  ['dict', 'dict'], ['class', 'your classes'], ['callable', 'function'], ['coroutine', 'coroutine'], ['exception', 'exception'], ['any', 'Any / unknown'],
];

export function Legend() {
  const [open, setOpen] = useState(false);
  const filters = useStore(s => s.layout.filters);
  const setFilters = useStore(s => s.setFilters);
  const toggleLevel = (l: number) => {
    const on = filters.inputLevels.includes(l) && filters.outputLevels.includes(l);
    const flip = (xs: number[]) => (on ? xs.filter(x => x !== l) : [...new Set([...xs, l])].sort());
    setFilters({ inputLevels: flip(filters.inputLevels), outputLevels: flip(filters.outputLevels) });
  };
  const toggleRule = (r: string) =>
    setFilters({ hidden: filters.hidden.includes(r) ? filters.hidden.filter(x => x !== r) : [...filters.hidden, r] });
  const levelOff = (l: number) => !(filters.inputLevels.includes(l) && filters.outputLevels.includes(l));
  if (!open) return <button className="cf-legend-chip" onClick={() => setOpen(true)} title="What the colours and shapes mean"><Icon name="symbol-color" /> Legend</button>;
  return (
    <div className="cf-legend">
      <div className="cf-legend-head"><Icon name="symbol-color" /> <b>Legend</b><span className="cf-muted"> · click to show / hide</span>
        <button className="cf-icon-btn" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <div className="cf-legend-title">Wires</div>
      {[1, 2, 3].map(l => (
        <div key={l} className={`cf-legend-row ${levelOff(l) ? 'off' : ''}`} onClick={() => toggleLevel(l)}>
          <Wire cls={`cf-l${l}`} /><span>{['level 1 · arguments in, return value out', 'level 2 · calls a function (and Depends)', 'level 3 · calls a method, reads / writes a global'][l - 1]}</span>
        </div>
      ))}
      <div className={`cf-legend-row ${filters.hidden.includes('flag:unresolved') ? 'off' : ''}`} onClick={() => toggleRule('flag:unresolved')}><Wire cls="cf-l2 cf-unresolved" /><span>dashed · not sure where it goes (never hidden by levels)</span></div>
      <div className={`cf-legend-row ${filters.hidden.includes('wire:reference') ? 'off' : ''}`} onClick={() => toggleRule('wire:reference')}><Wire cls="cf-l2 cf-k-reference" /><span>dotted · function passed as a value</span></div>
      <div className={`cf-legend-row ${filters.hidden.includes('wire:depends') ? 'off' : ''}`} onClick={() => toggleRule('wire:depends')}><Wire cls="cf-l2 cf-k-depends" /><span>purple · Depends(...)</span></div>
      <div className={`cf-legend-row ${filters.hidden.includes('wire:decorates') ? 'off' : ''}`} onClick={() => toggleRule('wire:decorates')}><Wire cls="cf-l1 cf-k-decorates" /><span>decorator output → decorated function</span></div>
      <div className={`cf-legend-row ${filters.hidden.includes('wire:flow') ? 'off' : ''}`} onClick={() => toggleRule('wire:flow')}><Wire cls="cf-l1 cf-k-flow" /><span>dash-dot · return value flows into an argument (library calls between are skipped, named "via …")</span></div>
      <div className="cf-legend-row static"><span className="cf-legend-arrows">◀━━▶</span><span>arrows at both ends · one wire = call in + return back</span></div>
      <div className="cf-legend-title">Ports</div>
      <div className="cf-legend-grid">
        <span><Port shape="arrow" /> call in / calls out</span>
        <span><Port shape="circle" color="var(--cf-type-int)" /> argument / return</span>
        <span><Port shape="hollow" color="var(--cf-type-str)" /> has a default</span>
        <span><Port shape="diamond" color="var(--cf-type-callable)" /> takes a function</span>
        <span><Port shape="grid" /> *args / grouped</span>
      </div>
      <div className="cf-legend-title">Types (port and badge colour)</div>
      <div className="cf-legend-grid">
        {TYPES.map(([k, label]) => <span key={k}><i className="cf-dot" style={{ background: `var(--cf-type-${k})` }} />{label}</span>)}
      </div>
      <div className="cf-legend-title">While tracing</div>
      <div className="cf-legend-grid">
        <span><i className="cf-dot cf-dot-glow" />node glows · it ran</span>
        <span><i className="cf-dot" style={{ background: 'var(--cf-wire-l2)' }} />ball · a call travelling</span>
        <span><i className="cf-dot cf-dot-ring" />ring · its return value</span>
        <span><b>×3</b> · repeated calls</span>
      </div>
    </div>
  );
}

const CARDS: { icon: string; title: string; text: string; keys?: string; preview?: ReactNode }[] = [
  { icon: 'map', title: 'Canvas', text: 'Each box is a function or method; classes are frames around their methods. Entry points are on the left, what they call flows to the right. Drag to pan, scroll to zoom, drag boxes anywhere — positions are saved.', keys: '1 fit · 0 100% · 2 zoom to selection · right-click for menus' },
  { icon: 'symbol-function', title: 'Nodes', text: 'Header: name, async and @decorator chips, docstring line. Rows: arguments (left) and the return value (right). Hover for path, signature and docstring. Double-click opens just that function to edit.', keys: 'Dbl-click open · Space collapse · H hide' },
  { icon: 'symbol-type-parameter', title: 'Ports & types', text: 'Port colour = data type (same colour in the inspector and the log). Shape = role: arrow for the call, hollow when the argument has a default, diamond when it takes a function.', preview: <span><Port shape="arrow" /> <Port shape="circle" color="var(--cf-type-int)" /> <Port shape="hollow" color="var(--cf-type-str)" /> <Port shape="diamond" color="var(--cf-type-callable)" /></span> },
  { icon: 'git-compare', title: 'Wires & levels', text: 'Level 1: arguments and return values. Level 2: calls to functions (and Depends). Level 3: method calls and globals. In/Out buttons pick which levels you see; with a node selected they are read from its point of view.', preview: <span><Wire cls="cf-l1" w={34} /> <Wire cls="cf-l2" w={34} /> <Wire cls="cf-l3" w={34} /> <Wire cls="cf-l2 cf-unresolved" w={34} /></span>, keys: 'Click a wire: follow it · Alt+click: follow back' },
  { icon: 'filter', title: 'Filters', text: 'Filters menu: show or hide by file, package, library, node kind, wire kind, flags or type. Alt+click (or ◎) solos one entry. Active filters show as chips under the toolbar.', keys: 'W only this node\'s wires · Shift+W inputs · Alt+W outputs · F neighbours · Esc clear' },
  { icon: 'debug-alt', title: 'Tracing', text: 'Trace tests / Trace launch runs your code under the tracer: nodes light up, balls travel along the wires, and every call lands in the log. Hover a wire or open the Inspector to see the last values.' },
  { icon: 'inspect', title: 'Inspector', text: 'Everything about the selected node or wire: overview, values (tree, table, JSON), types expanded down to builtins, callers, callees, source and stats.' },
  { icon: 'eye', title: 'Follow', text: 'Follow mode moves the camera with the ball. The traced program waits at each step until the animation has caught up, so you can watch the pipeline one call at a time.' },
  { icon: 'debug-breakpoint', title: 'Intercept', text: 'Right-click → Intercept: the program pauses when it reaches that function. Edit the arguments, then Continue, Skip (return a value you type) or Stop.' },
  { icon: 'zap', title: 'Inject', text: 'Right-click → Inject call: call any function with arguments you type (Python expressions), in the running program or a fresh one, and watch the pipeline light up.' },
];

export function GuideOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="cf-guide-backdrop" onClick={onClose}>
      <div className="cf-guide" onClick={e => e.stopPropagation()}>
        <div className="cf-guide-head"><Icon name="book" /><h2>Code Flow Canvas — guide</h2>
          <button className="cf-icon-btn" onClick={onClose} title="Close"><Icon name="close" /></button></div>
        <div className="cf-guide-grid">
          {CARDS.map(c => (
            <section key={c.title} className="cf-guide-card">
              <h3><Icon name={c.icon} /> {c.title}</h3>
              <p>{c.text}</p>
              {c.preview && <div className="cf-guide-preview">{c.preview}</div>}
              {c.keys && <div className="cf-guide-keys"><Icon name="keyboard" /> {c.keys}</div>}
            </section>
          ))}
        </div>
        <div className="cf-guide-foot cf-muted">Reopen any time with <b>? Guide</b> in the toolbar. Colours: setting <code>codeflow.colorScheme</code>.</div>
      </div>
    </div>
  );
}
