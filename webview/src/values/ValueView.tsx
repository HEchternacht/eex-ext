// Expandable views of traced values (UIX_RESEARCH.md 2.10): tree with type badges, auto table, JSON.
import { useState } from 'react';
import type { ValueTree } from '../../../shared/protocol';
import { Icon } from '../nodes/CodeNode';
import { typeColor } from '../theme';

const PREVIEW = 100;
const STR_MAX = 120;
const open = new Map<string, boolean>();   // expansion state by path, kept across runs and re-renders

const KIND_TYPE: Partial<Record<ValueTree['k'], string>> = {
  none: 'None', bool: 'bool', int: 'int', float: 'float', str: 'str', bytes: 'bytes', list: 'list', tuple: 'tuple',
  set: 'set', dict: 'dict', callable: 'Callable', coroutine: 'Coroutine', exception: 'Exception',
};

const shortType = (v: ValueTree) => v.t.split('.').pop()!;
const SIZED = new Set(['list', 'tuple', 'set', 'dict', 'bytes']);
const badge = (v: ValueTree) => `${shortType(v)}${v.n != null && SIZED.has(v.k) ? `[${v.n}]` : ''}`;

function Scalar({ v }: { v: ValueTree }) {
  const [all, setAll] = useState(false);
  if (v.k === 'str') {
    const s = v.r;
    const long = s.length > STR_MAX;
    return <span className="cf-v-str" title={s}>{long && !all ? s.slice(0, STR_MAX) + '…' : s}
      {long && <button className="cf-link" onClick={() => setAll(!all)}>{all ? 'less' : `+${s.length - STR_MAX} chars`}</button>}</span>;
  }
  const cls = v.k === 'none' || v.k === 'bool' ? 'cf-v-kw' : v.k === 'int' || v.k === 'float' || v.k === 'complex' ? 'cf-v-num'
    : v.k === 'exception' ? 'cf-v-err' : 'cf-v-other';
  return <span className={cls} title={v.r}>{v.r}</span>;
}

/** One-line preview of a container / object: `{a: 1, b: 'x', …}`, `[0, 1, 2, …]`, `Frame(w=640, …)`. */
export function preview(v: ValueTree): string {
  if (!v.items) return v.r;
  const parts = v.items.slice(0, 5).map(i => {
    const inner = i.v.items ? (i.v.k === 'dict' ? '{…}' : i.v.k === 'list' || i.v.k === 'tuple' ? '[…]' : `${shortType(i.v)}(…)`) : i.v.r;
    return v.k === 'list' || v.k === 'tuple' || v.k === 'set' ? inner : `${i.key}${v.k === 'dict' ? ': ' : '='}${inner}`;
  });
  const more = (v.items.length > 5 || v.more) ? ', …' : '';
  const body = parts.join(', ') + more;
  const text = v.k === 'dict' ? `{${body}}` : v.k === 'list' ? `[${body}]` : v.k === 'tuple' ? `(${body})` : v.k === 'set' ? `{${body}}` : `${shortType(v)}(${body})`;
  return text.length > PREVIEW ? text.slice(0, PREVIEW - 1) + '…' : text;
}

function Row({ name, v, path, depth }: { name: string | number; v: ValueTree; path: string; depth: number }) {
  const expandable = !!v.items?.length || !!v.more;
  const [isOpen, setOpen] = useState(open.get(path) ?? (depth === 0 && expandable));
  const toggle = () => { open.set(path, !isOpen); setOpen(!isOpen); };
  return (
    <>
      <div className="cf-v-row" style={{ paddingLeft: depth * 12 }} onClick={expandable ? toggle : undefined}>
        <span className="cf-v-twistie">{expandable && <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />}</span>
        <span className="cf-v-key">{name}</span>
        <span className="cf-v-badge" style={{ color: typeColor(KIND_TYPE[v.k] ?? v.t) }}>{v.k === 'cycle' ? '↺ cycle' : badge(v)}</span>
        <span className="cf-v-preview">{v.items && !isOpen ? preview(v) : v.items ? '' : <Scalar v={v} />}</span>
        <button className="cf-v-copy" title="Copy value" onClick={e => { e.stopPropagation(); void navigator.clipboard?.writeText(JSON.stringify(toJson(v), null, 2)); }}>
          <Icon name="copy" /></button>
      </div>
      {isOpen && v.items?.map(i => <Row key={String(i.key)} name={i.key} v={i.v} path={`${path}.${i.key}`} depth={depth + 1} />)}
      {isOpen && !!v.more && (
        <div className="cf-v-row cf-v-more" style={{ paddingLeft: (depth + 1) * 12 + 16 }}>
          … {v.more} more (limit <code>codeflow.trace.valueItems</code>)
        </div>
      )}
    </>
  );
}

/** Plain JSON for the JSON view / copy: scalars parsed from their repr where possible. */
export function toJson(v: ValueTree): unknown {
  if (v.items) {
    if (v.k === 'list' || v.k === 'tuple' || v.k === 'set') return v.items.map(i => toJson(i.v));
    return Object.fromEntries(v.items.map(i => [String(i.key), toJson(i.v)]));
  }
  switch (v.k) {
    case 'none': return null;
    case 'bool': return v.r === 'True';
    case 'int': case 'float': { const n = Number(v.r); return Number.isFinite(n) ? n : v.r; }
    case 'str': try { return JSON.parse(v.r.replace(/^'(.*)'$/s, (_, s) => JSON.stringify(s))); } catch { return v.r; }
    default: return `<${v.t}>`;
  }
}

/** Table view when a list holds dicts / objects that share keys (n8n Table). Columns: union of keys, max 20. */
export function tableOf(v: ValueTree): { cols: string[]; rows: ValueTree[][] } | null {
  if (!(v.k === 'list' || v.k === 'tuple') || !v.items?.length) return null;
  if (!v.items.every(i => i.v.items && ['dict', 'object', 'dataclass', 'pydantic'].includes(i.v.k))) return null;
  const cols: string[] = [];
  for (const i of v.items) for (const c of i.v.items!) if (!cols.includes(String(c.key)) && cols.length < 20) cols.push(String(c.key));
  const rows = v.items.map(i => cols.map(c => i.v.items!.find(x => String(x.key) === c)?.v ?? { t: '', k: 'none', r: '' } as ValueTree));
  return { cols, rows };
}

type Mode = 'tree' | 'table' | 'json';

/** Value with view switch: Tree | Table (when tabular) | JSON. */
export function ValueView({ name, value, path }: { name: string; value: ValueTree; path: string }) {
  const table = tableOf(value);
  const [mode, setMode] = useState<Mode>('tree');
  const m = mode === 'table' && !table ? 'tree' : mode;
  return (
    <div className="cf-value">
      {(value.items || table) && (
        <div className="cf-v-modes">
          {(['tree', ...(table ? ['table'] : []), 'json'] as Mode[]).map(x => (
            <button key={x} className={m === x ? 'on' : ''} onClick={() => setMode(x)}>{x[0].toUpperCase() + x.slice(1)}</button>
          ))}
        </div>
      )}
      {m === 'tree' && <Row name={name} v={value} path={path} depth={0} />}
      {m === 'table' && table && (
        <div className="cf-v-table-wrap"><table className="cf-v-table">
          <thead><tr><th>#</th>{table.cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => (
            <tr key={i}><td>{i}</td>{r.map((c, j) => <td key={j} className={c.k === 'int' || c.k === 'float' ? 'num' : ''}>{c.items ? preview(c) : c.r}</td>)}</tr>
          ))}</tbody>
        </table></div>
      )}
      {m === 'json' && <pre className="cf-v-json">{JSON.stringify(toJson(value), null, 2)}</pre>}
    </div>
  );
}
