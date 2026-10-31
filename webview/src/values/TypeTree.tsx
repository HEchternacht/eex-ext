import { useState } from 'react';
import { Icon } from '../nodes/CodeNode';
import { typeColor } from '../theme';
import { showType, type TypeNode } from '../types';

/** Declared type expanded down to builtins: project classes open into their fields (n8n Schema view). */
export function TypeTree({ name, t, depth = 0 }: { name: string; t: TypeNode; depth?: number }) {
  const children: { name: string; t: TypeNode }[] = [
    ...(t.fields ?? []).map(f => ({ name: f.name, t: f.type })),
    ...t.args.filter(a => a.fields || a.args.length).map((a, i) => ({ name: t.name === 'Union' ? `|${i}` : `[${i}]`, t: a })),
  ];
  const [open, setOpen] = useState(depth < 1);
  const expandable = children.length > 0 && !t.cycle;
  return (
    <>
      <div className="cf-v-row" style={{ paddingLeft: depth * 12 }} onClick={expandable ? () => setOpen(!open) : undefined}>
        <span className="cf-v-twistie">{expandable && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}</span>
        <span className="cf-v-key">{name}</span>
        <span className="cf-v-badge" style={{ color: typeColor(showType(t)) }}>{showType(t)}</span>
        {t.cycle && <span className="cf-v-preview cf-muted">↺ already expanded above</span>}
        {t.cls && !t.cycle && <span className="cf-v-preview cf-muted">class · {t.fields?.length ?? 0} fields</span>}
      </div>
      {open && expandable && children.map(c => <TypeTree key={c.name} name={c.name} t={c.t} depth={depth + 1} />)}
    </>
  );
}
