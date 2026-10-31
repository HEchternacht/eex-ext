// Pure view computation: collapse, filters, level logic, wires-on-demand. No React here (unit-tested with vitest).
import type { GraphEdge, GraphNode, Level, Port } from '../../shared/graph';
import type { Filters, NodeLayout } from '../../shared/layout';
import { unionParts } from './theme';

export type LevelMode = 'relative' | 'fixed';

export interface ViewInput {
  root?: string;            // workspace root: file rules are relative to it
  focus?: Focus | null;     // context-menu "show only ..." (not persisted)
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Record<string, NodeLayout>;
  filters: Filters;
  lockedEdges: string[];
  selected: string | null;
  levelMode: LevelMode;
  edgeThreshold: number;
  bridgeHidden?: boolean;   // draw a dashed "via" wire where calls pass through hidden nodes
}

export interface ViewEdge {
  id: string;               // id of the drawn (possibly merged) wire
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  edges: GraphEdge[];       // underlying graph edges (several when merged by collapse)
  rerouted: boolean;
}

export interface View {
  nodes: GraphNode[];       // parents before children
  edges: ViewEdge[];
  hiddenByCollapse: Set<string>;
  wiresOnDemand: boolean;
  autoWires: boolean;        // wires on demand because too many wires would show (not the user's choice)
}

interface Side { in?: Level; out?: Level }

const SPECIAL_KINDS = new Set(['imports', 'globals', 'unresolved']);

/** Transient focus from the context menu: one node's wires (all / inputs / outputs), one wire's two ends,
 * or a call chain (everything the node calls, transitively, or everything that calls it). */
export type Focus = { node: string; dir: 'all' | 'in' | 'out' } | { edge: string } | { node: string; chain: 'forward' | 'backward' };

const CHAIN_KINDS = new Set(['call', 'method_call', 'depends']);

/** Call chain from `start` (and what it contains: a class's methods, a module's functions):
 * node id -> distance (calls followed forward, or callers backward).
 * Depends wires are drawn provider -> consumer, so their call direction is reversed.
 * Imports / Globals / Unresolved end a chain: they are hubs, not callers. */
export function callChain(edges: GraphEdge[], nodes: Map<string, GraphNode>, start: string, dir: 'forward' | 'backward'): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (!CHAIN_KINDS.has(e.kind)) continue;
    const [caller, callee] = e.kind === 'depends' ? [e.target, e.source] : [e.source, e.target];
    const [from, to] = dir === 'forward' ? [caller, callee] : [callee, caller];
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const file = nodes.get(start)?.file;   // a package's __init__ must not pull in its submodules
  const queue = [...nodes.values()].filter(n => n.id === start || (n.id.startsWith(start + '.') && (!file || n.file === file))).map(n => n.id);
  const dist = new Map(queue.map(id => [id, 0]));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (dist.get(id)! > 0 && SYMBOL_PORT_KINDS.has(nodes.get(id)?.kind ?? '')) continue;
    for (const to of next.get(id) ?? []) {
      if (dist.has(to)) continue;
      dist.set(to, dist.get(id)! + 1);
      queue.push(to);
    }
  }
  return dist;
}

/** Dashed "via" wires A -> C for calls that pass only through hidden nodes (A -> hidden... -> C). */
export function bridgeEdges(edges: GraphEdge[], nodes: Map<string, GraphNode>, hidden: (id: string) => boolean): GraphEdge[] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (!CHAIN_KINDS.has(e.kind)) continue;
    const [caller, callee] = e.kind === 'depends' ? [e.target, e.source] : [e.source, e.target];
    next.set(caller, [...(next.get(caller) ?? []), callee]);
  }
  const out: GraphEdge[] = [];
  for (const a of next.keys()) {
    if (hidden(a)) continue;
    const via = new Map<string, string>();   // hidden node -> the first hidden node on the way (label)
    const queue: string[] = [];
    for (const h of next.get(a)!) if (hidden(h) && !SYMBOL_PORT_KINDS.has(nodes.get(h)?.kind ?? '') && !via.has(h)) { via.set(h, h); queue.push(h); }
    const found = new Map<string, string>();
    for (let i = 0; i < queue.length; i++) {
      for (const to of next.get(queue[i]) ?? []) {
        if (to === a || via.has(to) || found.has(to)) continue;
        if (!hidden(to)) found.set(to, via.get(queue[i])!);
        else if (!SYMBOL_PORT_KINDS.has(nodes.get(to)?.kind ?? '')) { via.set(to, via.get(queue[i])!); queue.push(to); }
      }
    }
    for (const [c, first] of found) {
      if (next.get(a)!.includes(c)) continue;   // already called directly
      out.push({ id: `via|${a}|${c}`, kind: 'call', source: a, sourcePort: 'calls', target: c, targetPort: 'in', level: 2,
        external: nodes.get(c)?.kind === 'imports', resolved: false, typeIn: null, typeOut: null,
        label: `via ${first.split('.').pop()}`, args: [], sites: [] });
    }
  }
  return out.concat(flowBypass(edges, nodes, hidden));
}

/** A hidden node passes its inputs through to its outputs: A -flow-> hidden B -flow-> C becomes A -> C "via B". */
function flowBypass(edges: GraphEdge[], nodes: Map<string, GraphNode>, hidden: (id: string) => boolean): GraphEdge[] {
  const outs = new Map<string, GraphEdge[]>();
  for (const e of edges) if (e.kind === 'flow') outs.set(e.source, [...(outs.get(e.source) ?? []), e]);
  const out = new Map<string, GraphEdge>();
  for (const [a, first] of outs) {
    if (hidden(a)) continue;
    const via = new Map<string, string[]>();   // hidden node reached -> hidden nodes on the way
    const queue: string[] = [];
    for (const e of first) if (hidden(e.target) && !via.has(e.target)) { via.set(e.target, [e.target]); queue.push(e.target); }
    for (let i = 0; i < queue.length; i++) {
      for (const e of outs.get(queue[i]) ?? []) {
        const path = via.get(queue[i])!;
        if (e.target === a) continue;
        if (hidden(e.target)) {
          if (!via.has(e.target)) { via.set(e.target, [...path, e.target]); queue.push(e.target); }
          continue;
        }
        const id = `via|flow|${a}|${e.target}|${e.targetPort}`;
        if (out.has(id) || first.some(d => d.target === e.target && d.targetPort === e.targetPort)) continue;
        const names = [...path.map(h => nodes.get(h)?.label ?? h.split('.').pop()!), ...(e.label?.replace(/^via /, '').split(', ') ?? [])];
        out.set(id, { ...e, id, source: a, resolved: false, label: `via ${names.join(', ')}`, sites: [] });
      }
    }
  }
  return [...out.values()];
}

const chainEdge = (e: GraphEdge, chain: Map<string, number>) => CHAIN_KINDS.has(e.kind) && chain.has(e.source) && chain.has(e.target);

export const relPath = (file: string, root = '') => {
  const f = file.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  return r.length > 1 && f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f;
};

const SYMBOL_PORT_KINDS = new Set(['imports', 'globals', 'unresolved']);

/** Rules a node matches, one list per category ('file', 'pkg', 'kind', 'node'). */
export function nodeRules(n: GraphNode, root?: string): Record<string, string[]> {
  const out: Record<string, string[]> = { kind: [`kind:${n.kind}`], node: [`node:${n.id}`] };
  if (n.file) {
    const rel = relPath(n.file, root);
    const parts = rel.split('/');
    // a folder rule covers the files directly in it (as the filter menu lists them), not its subfolders
    out.file = parts.length > 1 ? [`file:${rel}`, `file:${parts.slice(0, -1).join('/')}/`] : [`file:${rel}`];
  }
  if (n.module) {
    const parts = n.module.split('.');
    out.pkg = parts.map((_, i) => `pkg:${parts.slice(0, i + 1).join('.')}`);
  }
  return out;
}

/** Rules a wire matches ('wire', 'flag', 'type', 'lib'). */
export function edgeRules(e: GraphEdge, byId: Map<string, GraphNode>): Record<string, string[]> {
  const out: Record<string, string[]> = {
    wire: [`wire:${e.kind}`],
    flag: [e.resolved ? 'flag:resolved' : 'flag:unresolved', e.external ? 'flag:library' : 'flag:project'],
  };
  const t = e.typeOut ?? e.typeIn;
  if (t) out.type = [`type:${typeFamily(t)}`];
  const lib = byId.get(e.target)?.kind === 'imports' ? e.targetPort : byId.get(e.source)?.kind === 'imports' ? e.sourcePort : null;
  if (lib) out.lib = [`lib:${lib.split('.')[0]}`];
  return out;
}

/** Type family for the Types filter: the outer name of the first non-None union member ('Optional[list[int]]' -> 'list'). */
export function typeFamily(t: string): string {
  return unionParts(t).parts[0].split('[')[0].trim().split('.').pop() || 'None';
}

/** True when the rules hide the thing: a hidden rule matches, or a category has solos and none matches. */
export function matchesHidden(rules: Record<string, string[]>, hidden: Set<string>, solo: string[]): boolean {
  for (const list of Object.values(rules)) if (list.some(r => hidden.has(r))) return true;
  const soloBy = new Map<string, string[]>();
  for (const s of solo) {
    const cat = s.slice(0, s.indexOf(':'));
    soloBy.set(cat, [...(soloBy.get(cat) ?? []), s]);
  }
  for (const [cat, list] of soloBy) if (!(rules[cat] ?? []).some(r => list.includes(r))) return true;
  return false;
}

export interface PortGroup { key: string; ports: Port[] }

/**
 * Ports of Imports / Globals / Unresolved grouped by package: `asyncio.sleep` -> `asyncio` (libraries, by top
 * package), `app.config.SETTINGS` -> `app.config` (globals and unresolved, by module). Groups keep first-seen order.
 */
const groupCache = new WeakMap<GraphNode, PortGroup[]>();

export function portGroups(n: GraphNode): PortGroup[] {
  const cached = groupCache.get(n);
  if (cached) return cached;
  const groups = new Map<string, Port[]>();
  for (const p of n.ports) {
    const parts = p.id.split('.');
    const key = parts.length < 2 ? p.id : n.kind === 'imports' ? parts[0] : parts.slice(0, -1).join('.');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out = [...groups].map(([key, ports]) => ({ key, ports }));
  groupCache.set(n, out);
  return out;
}

/** Handle a port is drawn on: a closed group (the default) shows one handle for all its ports. */
export function portHandle(n: GraphNode, port: string, layout: NodeLayout | undefined): string {
  if (!SPECIAL_KINDS.has(n.kind)) return port;
  const g = portGroups(n).find(x => x.ports.some(p => p.id === port));
  return g && g.ports.length > 1 && !layout?.openGroups?.includes(g.key) ? `group:${g.key}` : port;
}

/** Level of a wire as seen from each endpoint (relative mode). */
export function sideLevels(e: GraphEdge): { src: Side; tgt: Side } {
  switch (e.kind) {
    case 'call':
    case 'method_call':
    case 'reference':
      // caller: call out + value back in at the caller's level; callee: args in, return out = level 1
      return { src: { in: e.level, out: e.level }, tgt: { in: 1, out: 1 } };
    case 'depends':
      return { src: { out: 1 }, tgt: { in: 2 } };
    case 'decorates':
      return { src: { out: 1 }, tgt: { in: e.level } };
    case 'global_read':
      return { src: {}, tgt: { in: 3 } };
    case 'global_write':
      return { src: { out: 3 }, tgt: {} };
    case 'flow':
      return { src: { out: 1 }, tgt: { in: 1 } };
  }
}

/** Single level of a wire in fixed mode. */
export function fixedLevel(e: GraphEdge): Level {
  return e.kind === 'depends' || e.kind === 'decorates' && e.targetPort.startsWith('arg:') ? 1 : e.level;
}

export function levelVisible(e: GraphEdge, f: Filters, selected: string | null, mode: LevelMode): boolean {
  const I = new Set(f.inputLevels);
  const O = new Set(f.outputLevels);
  if (mode === 'fixed') {
    const l = fixedLevel(e);
    if (selected === e.target) return I.has(l);
    if (selected === e.source) return O.has(l);
    return I.has(l) && O.has(l);
  }
  if (selected && (selected === e.source || selected === e.target)) {
    const { src, tgt } = sideLevels(e);
    const side = selected === e.source ? src : tgt;
    return (side.in !== undefined && I.has(side.in)) || (side.out !== undefined && O.has(side.out));
  }
  return I.has(e.level) && O.has(e.level);
}

export function pathMatches(file: string | null, pattern: string): boolean {
  if (!pattern.trim()) return true;
  if (!file) return true;
  const f = file.replace(/\\/g, '/').toLowerCase();
  const p = pattern.trim().replace(/\\/g, '/').toLowerCase();
  if (!/[*?]/.test(p)) return f.includes(p);
  const re = new RegExp(p.split('**').map(s => s.split('*').map(escape).join('[^/]*')).join('.*').replace(/\?/g, '.'));
  return re.test(f);
}

function escape(s: string) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function depth(byId: Map<string, GraphNode>, id: string): number {
  let d = 0;
  let cur = byId.get(id)?.parentId;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = byId.get(cur)?.parentId;
  }
  return d;
}

/** Topmost collapsed ancestor (or the node itself). */
export function representative(byId: Map<string, GraphNode>, layout: Record<string, NodeLayout>, id: string): string {
  let rep = id;
  let cur = byId.get(id)?.parentId;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (layout[cur]?.collapsed) rep = cur;
    cur = byId.get(cur)?.parentId;
  }
  return rep;
}

export function computeView(v: ViewInput): View {
  const byId = new Map(v.nodes.map(n => [n.id, n]));
  const f = v.filters;
  const rep = new Map<string, string>();
  const hiddenByCollapse = new Set<string>();
  for (const n of v.nodes) {
    const r = representative(byId, v.layout, n.id);
    rep.set(n.id, r);
    if (r !== n.id) hiddenByCollapse.add(n.id);
  }
  const hidden = new Set(f.hidden ?? []);
  const solo = f.solo ?? [];
  const nodeSolo = solo.filter(s => /^(file|pkg|kind|node):/.test(s));
  const edgeSolo = solo.filter(s => !/^(file|pkg|kind|node):/.test(s));
  const ruleHidden = new Set<string>();
  if (hidden.size || nodeSolo.length) {
    const soloFail = new Set<string>();
    for (const n of v.nodes) {
      const rules = nodeRules(n, v.root);
      if (matchesHidden(rules, hidden, [])) ruleHidden.add(n.id);
      // Imports / Globals / Unresolved have no file or module: only kind/node solos apply to them
      else if (matchesHidden(rules, hidden, SYMBOL_PORT_KINDS.has(n.kind) ? nodeSolo.filter(s => /^(kind|node):/.test(s)) : nodeSolo)) soloFail.add(n.id);
    }
    // a frame failing a solo stays when something inside it passes
    const keepFrame = new Set<string>();
    for (const n of v.nodes) {
      if (ruleHidden.has(n.id) || soloFail.has(n.id)) continue;
      for (let p = n.parentId; p && !keepFrame.has(p); p = byId.get(p)?.parentId ?? null) keepFrame.add(p);
    }
    for (const id of soloFail) if (!keepFrame.has(id)) ruleHidden.add(id);
    // hiding a frame does not hide what is inside it: its children move up to the nearest shown ancestor (below)
  }
  const pathOk = (n: GraphNode | undefined) => !!n && !ruleHidden.has(n.id) && (n.file === null || pathMatches(n.file, f.pathFilter));

  const chain = v.focus && 'chain' in v.focus ? callChain(v.edges, byId, v.focus.node, v.focus.chain) : null;
  let edges = v.edges.filter(e => {
    if (f.ignoreLibraryConnections && e.external) return false;
    if (!pathOk(byId.get(e.source)) || !pathOk(byId.get(e.target))) return false;
    if ((hidden.size || edgeSolo.length) && matchesHidden(edgeRules(e, byId), hidden, edgeSolo)) return false;
    return !!chain || levelVisible(e, f, v.selected, v.levelMode);   // a chain shows every call in it
  });
  if (v.bridgeHidden && !chain && (ruleHidden.size || f.pathFilter.trim())) {
    const isHidden = (id: string) => !pathOk(byId.get(id));
    edges.push(...bridgeEdges(v.edges, byId, isHidden).filter(e => !(f.ignoreLibraryConnections && e.external)));
  }
  if (chain) edges = edges.filter(e => chainEdge(e, chain));
  else if (v.focus) {
    const fo = v.focus as Exclude<Focus, { chain: string }>;
    edges = edges.filter(e => 'edge' in fo ? e.id === fo.edge
      : fo.dir === 'in' ? e.target === fo.node : fo.dir === 'out' ? e.source === fo.node : e.source === fo.node || e.target === fo.node);
  }

  // counted after filters: two visible nodes never hit the limit, however big the whole graph is
  const autoWires = !chain && edges.length > v.edgeThreshold;
  const wiresOnDemand = f.wiresOnDemand || autoWires;
  const locked = new Set(v.lockedEdges);
  const selRep = v.selected ? rep.get(v.selected) ?? v.selected : null;
  const touchesSel = (e: GraphEdge) =>
    !!selRep && (rep.get(e.source) === selRep || rep.get(e.target) === selRep || e.source === v.selected || e.target === v.selected);
  if (wiresOnDemand && !chain) edges = edges.filter(e => locked.has(e.id) || touchesSel(e));

  let visibleIds: Set<string> | null = null;
  if (chain) visibleIds = new Set(chain.keys());
  else if (v.focus && 'edge' in v.focus) {
    const e = v.edges.find(x => x.id === (v.focus as { edge: string }).edge);
    visibleIds = new Set(e ? [e.source, e.target] : []);
  } else if (f.neighboursOnly && v.selected) {
    edges = edges.filter(e => touchesSel(e) || locked.has(e.id));
    visibleIds = new Set([v.selected]);
    for (const e of edges) {
      visibleIds.add(e.source);
      visibleIds.add(e.target);
    }
  }

  // merge wires whose endpoints collapse into the same frames
  const merged = new Map<string, ViewEdge>();
  for (const e of edges) {
    const s = chain ? e.source : rep.get(e.source) ?? e.source;   // a chain ignores collapsed frames
    const t = chain ? e.target : rep.get(e.target) ?? e.target;
    if (s === t && (s !== e.source || t !== e.target)) continue; // internal to a collapsed frame
    const sh = s === e.source ? portHandle(byId.get(s)!, e.sourcePort, v.layout[s]) : 'calls';
    const th = t === e.target ? portHandle(byId.get(t)!, e.targetPort, v.layout[t]) : 'in';
    const rerouted = s !== e.source || t !== e.target || sh !== e.sourcePort || th !== e.targetPort;
    const key = rerouted ? `merged|${s}|${sh}|${t}|${th}` : e.id;
    const cur = merged.get(key);
    if (cur) cur.edges.push(e);
    else merged.set(key, { id: key, source: s, sourceHandle: sh, target: t, targetHandle: th, edges: [e], rerouted });
  }

  // a chain is shown without frames: just its functions, free to be packed tightly
  let nodes = chain
    ? v.nodes.filter(n => chain.has(n.id) && n.kind !== 'class' && n.kind !== 'module' && pathOk(n)).map(n => ({ ...n, parentId: null }))
    : v.nodes.filter(n => !hiddenByCollapse.has(n.id) && pathOk(n));
  if (f.ignoreLibraryConnections) nodes = nodes.filter(n => n.kind !== 'imports');
  if (visibleIds && !chain) {
    const keep = new Set<string>();
    for (const id of visibleIds) {
      let cur: string | null | undefined = rep.get(id) ?? id;
      while (cur && !keep.has(cur)) {   // keep ancestors so nested nodes have their frames
        keep.add(cur);
        cur = byId.get(cur)?.parentId;
      }
    }
    nodes = nodes.filter(n => keep.has(n.id));
  }
  const nodeSet = new Set(nodes.map(n => n.id));
  // a hidden parent does not take its children along: they hang from the nearest shown ancestor (or the root)
  const shownAncestor = (id: string | null): string | null => {
    for (let p = id; p; p = byId.get(p)?.parentId ?? null) if (nodeSet.has(p)) return p;
    return null;
  };
  nodes = nodes
    .map(n => (n.parentId && !nodeSet.has(n.parentId) ? { ...n, parentId: shownAncestor(n.parentId) } : n))
    .sort((a, b) => depth(byId, a.id) - depth(byId, b.id));
  const viewEdges = [...merged.values()].filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
  // Imports / Globals / Unresolved only matter while something is wired to them
  const wired = new Set(viewEdges.flatMap(e => [e.source, e.target]));
  nodes = nodes.filter(n => !SPECIAL_KINDS.has(n.kind) || wired.has(n.id) || (!f.pathFilter.trim() && !wiresOnDemand && !visibleIds));
  return { nodes, edges: viewEdges, hiddenByCollapse, wiresOnDemand, autoWires };
}

/** Default collapse for big graphs: classes first, then modules. Only for nodes without a saved state. */
export function defaultCollapsed(nodes: GraphNode[], layout: Record<string, NodeLayout>, threshold: number): string[] {
  const fns = nodes.filter(n => ['function', 'method', 'property', 'lambda', 'decorator'].includes(n.kind));
  if (fns.length <= threshold) return [];
  const classes = nodes.filter(n => n.kind === 'class' && layout[n.id]?.collapsed === undefined).map(n => n.id);
  const insideClasses = new Set(fns.filter(n => classes.some(c => n.id.startsWith(c + '.'))).map(n => n.id));
  if (fns.length - insideClasses.size <= threshold) return classes;
  return [...classes, ...nodes.filter(n => n.kind === 'module' && layout[n.id]?.collapsed === undefined).map(n => n.id)];
}
