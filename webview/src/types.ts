// Type expander: annotation strings -> trees, project classes expanded into their fields down to builtins.
import type { GraphNode } from '../../shared/graph';
import type { ValueTree } from '../../shared/protocol';

export interface TypeNode {
  name: string;              // 'list', 'Optional', 'app.models.Frame' as written (last segment shown)
  args: TypeNode[];          // subscript arguments / union members
  fields?: { name: string; type: TypeNode }[];   // project classes, expanded
  cls?: string;              // node id of the project class
  cycle?: boolean;           // class already expanded higher up
}

/** Parse `dict[str, list[Optional[int | str]]]`, `X | None`, `Annotated[X, ...]`, `tuple[int, ...]`. */
export function parseType(src: string): TypeNode {
  let i = 0;
  const s = src.trim();
  const ws = () => { while (s[i] === ' ') i++; };
  const union = (): TypeNode => {
    const parts = [atom()];
    ws();
    while (s[i] === '|') {
      i++;
      parts.push(atom());
      ws();
    }
    return parts.length === 1 ? parts[0] : { name: 'Union', args: parts };
  };
  const atom = (): TypeNode => {
    ws();
    if (s[i] === '[') {          // Callable[[a, b], r] argument list
      i++;
      const args = list(']');
      return { name: '[]', args };
    }
    let name = '';
    while (i < s.length && !'[],|'.includes(s[i])) name += s[i++];
    name = name.trim().replace(/^['"]|['"]$/g, '');
    ws();
    if (s[i] !== '[') return { name: name || '?', args: [] };
    i++;
    const args = list(']');
    const short = name.split('.').pop();
    if (short === 'Annotated') return args[0] ?? { name: 'Any', args: [] };
    return { name, args };
  };
  const list = (close: string): TypeNode[] => {
    const out: TypeNode[] = [];
    ws();
    while (i < s.length && s[i] !== close) {
      out.push(union());
      ws();
      if (s[i] === ',') i++;
      ws();
    }
    i++;
    return out;
  };
  return union();
}

/** Short display: `list[Optional[int]]`. */
export function showType(t: TypeNode): string {
  const short = t.name === '[]' ? '' : t.name === '...' ? '...' : t.name.split('.').pop()!;
  if (t.name === 'Union') return t.args.map(showType).join(' | ');
  return t.args.length ? `${short}[${t.args.map(showType).join(', ')}]` : short;
}

/**
 * Expand project classes (looked up by last name segment among class nodes) into their fields, recursively.
 * A class already being expanded higher up is marked `cycle` instead of expanded again.
 */
export function expandType(t: TypeNode, classes: Map<string, GraphNode>, seen: Set<string> = new Set()): TypeNode {
  const args = t.args.map(a => expandType(a, classes, seen));
  const cls = classes.get(t.name.split('.').pop()!);
  if (!cls || t.args.length) return { ...t, args };
  if (seen.has(cls.id)) return { ...t, args, cls: cls.id, cycle: true };
  const inner = new Set(seen).add(cls.id);
  const fields = (cls.fields ?? []).map(f => ({ name: f.name, type: expandType(parseType(f.type ?? 'Any'), classes, inner) }));
  return { ...t, args, cls: cls.id, fields };
}

/** Class nodes by short name, for expandType. Ambiguous names keep the first. */
export function classIndex(nodes: GraphNode[]): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const n of nodes) if (n.kind === 'class' && !m.has(n.label)) m.set(n.label, n);
  return m;
}

/** Best-guess type from a traced value when there is no annotation: `list[Item]`, `dict[str, int | None]`, objects with fields. */
export function inferType(v: ValueTree): TypeNode {
  const name = v.t.split('.').pop()!;
  const union = (ts: TypeNode[]): TypeNode => {
    const uniq = [...new Map(ts.map(t => [showType(t), t])).values()];
    return uniq.length === 1 ? uniq[0] : uniq.length ? { name: 'Union', args: uniq } : { name: 'Any', args: [] };
  };
  switch (v.k) {
    case 'none': return { name: 'None', args: [] };
    case 'list': case 'set': return { name, args: [union((v.items ?? []).map(i => inferType(i.v)))] };
    case 'tuple': return { name, args: (v.items ?? []).map(i => inferType(i.v)) };
    case 'dict': return { name, args: [{ name: 'str', args: [] }, union((v.items ?? []).map(i => inferType(i.v)))] };
    case 'object': case 'dataclass': case 'pydantic':
      return { name: v.t, args: [], fields: (v.items ?? []).map(i => ({ name: String(i.key), type: inferType(i.v) })) };
    default: return { name: v.t, args: [] };
  }
}
