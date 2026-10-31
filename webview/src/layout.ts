// Auto-layout with ELK (layered, hierarchical, left-to-right flow). Only nodes without a saved position take ELK's result.
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Graph, GraphEdge, GraphNode } from '../../shared/graph';
import type { NodeLayout } from '../../shared/layout';
import { portGroups } from './filters';

export const NODE_W = 240;
export const HEADER_H = 26;
export const ROW_H = 20;
export const DOC_H = 18;
export const SPECIAL_W = 260;
export const PILL_W = 200;

const elk = new ELK();

/** Size of a node drawn without children (or collapsed). Mirrors nodes/CodeNode.tsx. */
export function leafSize(n: GraphNode, l?: NodeLayout): { w: number; h: number } {
  if (n.kind === 'imports' || n.kind === 'globals' || n.kind === 'unresolved') {
    const rows = portGroups(n).reduce((sum, g) => sum + 1 + (g.ports.length > 1 && l?.openGroups?.includes(g.key) ? g.ports.length : 0), 0);
    return { w: SPECIAL_W, h: HEADER_H + Math.max(1, rows) * ROW_H + 4 };
  }
  if (n.kind === 'lambda') return { w: PILL_W, h: ROW_H + 6 };
  if (n.kind === 'module') return { w: NODE_W, h: HEADER_H + 2 };
  if (n.kind === 'class') return { w: NODE_W, h: HEADER_H + ROW_H + 2 };
  const args = n.ports.filter(p => p.role === 'arg').length;
  const doc = n.doc?.trim() ? DOC_H : 0;
  return { w: NODE_W, h: HEADER_H + doc + (args + 1) * ROW_H + 4 };
}

/** Header (+ class fields row): the top padding of a container. */
export function contentTop(n: GraphNode): number {
  return (n.kind === 'class' && !n.fields?.length ? HEADER_H : leafSize(n).h) + 8;
}

/**
 * groupByFile off: module nodes stop being containers. Their children move to the root (classes stay frames);
 * a module is kept as a small leaf only when its top-level code has project wires (calls, globals), not just imports.
 */
export function regroup(graph: Graph, groupByFile: boolean): Graph {
  if (groupByFile) return graph;
  const wired = new Set(graph.edges.filter(e => !e.external).flatMap(e => [e.source, e.target]));
  const modules = new Set(graph.nodes.filter(n => n.kind === 'module').map(n => n.id));
  const nodes = graph.nodes
    .filter(n => n.kind !== 'module' || wired.has(n.id))
    .map(n => (n.parentId && modules.has(n.parentId) ? { ...n, parentId: null } : n));
  return { ...graph, nodes };
}

const SPECIAL = new Set(['imports', 'globals', 'unresolved']);
const GAP = 12;
const LAYER_GAP = 48;

/** Wires that decide columns: caller -> callee; Depends reversed so the consumer sits left of its provider. */
function flowEdges(edges: GraphEdge[], ids: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const e of edges) {
    if (e.external || e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    if (e.kind === 'global_read' || e.kind === 'global_write') continue;
    out.push(e.kind === 'depends' ? [e.target, e.source] : [e.source, e.target]);
  }
  return out;
}

/**
 * Left-to-right flow: entry points (nothing in the project calls them) in the first column, callees to the right
 * of their callers, as close as possible (network simplex keeps wires short). Nodes without any wire are packed in
 * a grid under the flow. `order` sorts the input (first seen in the last trace, else source order); ELK only
 * uses it as a tie-break: model-order options crash elkjs with INCLUDE_CHILDREN.
 * Imports / Globals / Unresolved stay out of the flow: Globals left of it, the other two right of it.
 */
export async function autoLayout(nodes: GraphNode[], edges: GraphEdge[], order: Map<string, number> = new Map()): Promise<Record<string, NodeLayout>> {
  const specials = nodes.filter(n => SPECIAL.has(n.kind));
  const all = new Set(nodes.map(n => n.id));
  const special = new Set(specials.map(n => n.id));
  const pairs = flowEdges(edges, all).filter(([s, t]) => !special.has(s) && !special.has(t));
  const parentOf = new Map(nodes.map(n => [n.id, n.parentId && all.has(n.parentId) ? n.parentId : null]));
  // a root is wired when it or anything inside it has a flow wire
  const rootOf = (id: string): string => parentOf.get(id) ? rootOf(parentOf.get(id)!) : id;
  const wiredRoots = new Set(pairs.flat().map(rootOf));
  const loose = nodes.filter(n => !SPECIAL.has(n.kind) && !parentOf.get(n.id) && !wiredRoots.has(n.id));
  const looseIds = new Set(loose.map(n => n.id));
  const children = new Map<string | null, GraphNode[]>();
  for (const n of nodes) {
    if (special.has(n.id) || looseIds.has(n.id)) continue;
    const p = parentOf.get(n.id)!;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n);
  }
  const rank = (n: GraphNode) => order.get(n.id) ?? Number.MAX_SAFE_INTEGER;
  const src = (n: GraphNode) => `${n.file ?? ''}|${String(n.range?.start ?? 0).padStart(8, '0')}`;
  for (const list of children.values()) list.sort((a, b) => rank(a) - rank(b) || (src(a) < src(b) ? -1 : src(a) > src(b) ? 1 : 0));

  const called = new Set(pairs.map(p => p[1]));
  const calls = new Set(pairs.map(p => p[0]));
  const entry = (n: GraphNode) => !children.has(n.id) && calls.has(n.id) && !called.has(n.id);
  const options = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': String(GAP),
    'elk.spacing.componentComponent': String(GAP * 2),
    'elk.aspectRatio': '1.8',
    'elk.separateConnectedComponents': 'true',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(GAP),
  };
  const build = (n: GraphNode): ElkNode => {
    const kids = children.get(n.id) ?? [];
    const size = leafSize(n);
    const constraint: Record<string, string> = entry(n) ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {};
    if (!kids.length) return { id: n.id, width: size.w, height: size.h, layoutOptions: constraint };
    return {
      id: n.id,
      layoutOptions: { ...options, ...constraint, 'elk.padding': `[top=${contentTop(n)},left=8,bottom=8,right=8]` },
      children: kids.map(build),
    };
  };
  const root: ElkNode = {
    id: '__root',
    layoutOptions: { ...options, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    children: (children.get(null) ?? []).map(build),
    edges: pairs.map(([s, t], i) => ({ id: `f${i}`, sources: [s], targets: [t] })),
  };
  const out = await elk.layout(root);
  const result: Record<string, NodeLayout> = {};
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      result[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
      if (c.children?.length) {
        result[c.id].w = c.width;
        result[c.id].h = c.height;
      }
      walk(c);
    }
  };
  walk(out);

  // unwired nodes: a grid under the flow (containers among them get their own small layout first)
  const width = Math.max(out.width ?? 0, NODE_W * 4);
  let gx = 0, gy = (out.height ?? 0) + LAYER_GAP, rowH = 0;
  for (const n of loose) {
    let size = leafSize(n);
    if (children.has(n.id)) {
      const inner = await elk.layout({ id: '__loose', layoutOptions: options, children: [build(n)] });
      const c = inner.children![0];
      walk({ id: '', children: c.children ? [c] : [] });
      size = { w: c.width ?? size.w, h: c.height ?? size.h };
    }
    if (gx > 0 && gx + size.w > width) { gx = 0; gy += rowH + GAP; rowH = 0; }
    result[n.id] = { ...result[n.id], x: gx, y: gy };
    gx += size.w + GAP;
    rowH = Math.max(rowH, size.h);
  }

  // side columns for the special nodes
  const top = (out.children ?? []).map(c => c.y ?? 0);
  const y0 = top.length ? Math.min(...top) : 0;
  const right = (out.width ?? 0) + LAYER_GAP;
  let ry = y0;
  for (const n of specials) {
    if (n.kind === 'globals') result[n.id] = { x: -SPECIAL_W - LAYER_GAP, y: y0 };
    else {
      result[n.id] = { x: right, y: ry };
      ry += leafSize(n).h + GAP * 2;
    }
  }
  return result;
}

/** Compact columns for a call chain: callers left, callees right, one column per call distance.
 * Nested nodes move with their top-level frame (placed at its nearest member's distance). Columns are
 * stacked tightly and centred on each other so the whole chain takes as little room as possible. */
export function chainLayout(chain: Map<string, number>, dir: 'forward' | 'backward', byId: Map<string, GraphNode>,
  size: (id: string) => { w: number; h: number }): Record<string, { x: number; y: number }> {
  const top = (id: string) => {
    let cur = id;
    for (let p = byId.get(cur)?.parentId; p && byId.has(p); p = byId.get(p)?.parentId) cur = p;
    return cur;
  };
  const col = new Map<string, number>();
  for (const [id, d] of chain) {
    const t = top(id);
    const c = dir === 'forward' ? d : -d;
    if (!col.has(t) || Math.abs(c) < Math.abs(col.get(t)!)) col.set(t, c);
  }
  const columns = new Map<number, string[]>();
  for (const [id, c] of col) columns.set(c, [...(columns.get(c) ?? []), id]);   // chain order = discovery order
  const keys = [...columns.keys()].sort((a, b) => a - b);
  const heights = keys.map(k => columns.get(k)!.reduce((h, id) => h + size(id).h + GAP, -GAP));
  const tallest = Math.max(...heights);
  const out: Record<string, { x: number; y: number }> = {};
  let x = 0;
  keys.forEach((k, i) => {
    const ids = columns.get(k)!;
    let y = (tallest - heights[i]) / 2;
    for (const id of ids) {
      out[id] = { x, y };
      y += size(id).h + GAP;
    }
    x += Math.max(...ids.map(id => size(id).w)) + LAYER_GAP;
  });
  return out;
}
