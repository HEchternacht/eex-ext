import { describe, expect, it } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '../../shared/graph';
import { emptyLayout, withMode } from '../../shared/layout';
import { autoLayout, regroup } from './layout';

function node(id: string, kind: GraphNode['kind'] = 'function', parentId: string | null = 'm', line = 1): GraphNode {
  return { id, kind, label: id, module: 'm', qualname: id, parentId, file: 'C:/p/m.py', range: { start: line, end: line + 1, def: line },
    isAsync: false, ports: [{ id: 'in', name: 'in', dir: 'in', role: 'call', type: null }] };
}
function edge(kind: GraphEdge['kind'], source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${kind}|${source}|${target}`, kind, source, sourcePort: 'calls', target, targetPort: 'in', level: 2,
    external: false, resolved: true, typeIn: null, typeOut: null, label: null, args: [], sites: [], ...extra };
}

const nodes = [
  node('m', 'module', null), node('m.C', 'class'), node('m.C.run', 'method', 'm.C', 30),
  node('m.main', 'function', 'm', 50), node('m.a', 'function', 'm', 10), node('m.b', 'function', 'm', 20),
  node('m.provider', 'function', 'm', 5), node('m.lonely', 'function', 'm', 60),
  node('<imports>', 'imports', null), node('<globals>', 'globals', null),
];
const edges = [
  edge('call', 'm.main', 'm.a'), edge('call', 'm.a', 'm.b'), edge('method_call', 'm.b', 'm.C.run'),
  edge('depends', 'm.provider', 'm.a', { label: 'Depends' }),
  edge('call', 'm.b', '<imports>', { external: true }), edge('global_read', '<globals>', 'm.a'),
];
const graph: Graph = { root: 'C:/p', nodes, edges, errors: {} };

/** Absolute x of a node (positions of children are relative to their parent). */
function absX(pos: Record<string, { x: number }>, id: string, g: Graph): number {
  const n = g.nodes.find(x => x.id === id)!;
  return pos[id].x + (n.parentId ? absX(pos, n.parentId, g) : 0);
}

describe('flow layout', () => {
  it('flat: entry point leftmost, callees further right, Depends consumer left of provider', async () => {
    const g = regroup(graph, false);
    const pos = await autoLayout(g.nodes, g.edges);
    const x = (id: string) => absX(pos, id, g);
    expect(x('m.main')).toBeLessThan(x('m.a'));
    expect(x('m.a')).toBeLessThan(x('m.b'));
    expect(x('m.b')).toBeLessThan(x('m.C.run'));
    expect(x('m.a')).toBeLessThan(x('m.provider'));
    const flow = ['m.main', 'm.a', 'm.b', 'm.C', 'm.provider'].map(x);
    expect(x('<globals>')).toBeLessThan(Math.min(...flow));
    expect(x('<imports>')).toBeGreaterThan(Math.max(...flow));
  });

  it('flat: module frames dropped, children at the root, classes stay frames', () => {
    const g = regroup(graph, false);
    expect(g.nodes.find(n => n.id === 'm')).toBeUndefined();
    expect(g.nodes.find(n => n.id === 'm.main')!.parentId).toBeNull();
    expect(g.nodes.find(n => n.id === 'm.C.run')!.parentId).toBe('m.C');
  });

  it('flat: a module with wired top-level code stays as a leaf', () => {
    const g = regroup({ ...graph, edges: [...edges, edge('call', 'm', 'm.main')] }, false);
    expect(g.nodes.find(n => n.id === 'm')).toBeDefined();
  });

  it('file mode keeps module frames and still flows left to right', async () => {
    const g = regroup(graph, true);
    expect(g.nodes.find(n => n.id === 'm.main')!.parentId).toBe('m');
    const pos = await autoLayout(g.nodes, g.edges);
    const x = (id: string) => absX(pos, id, g);
    expect(x('m.main')).toBeLessThan(x('m.a'));
    expect(x('m.a')).toBeLessThan(x('m.b'));
    expect(pos.m.w).toBeGreaterThan(0);
  });

  it('tight spacing: neighbouring columns are less than 120px apart', async () => {
    const g = regroup(graph, false);
    const pos = await autoLayout(g.nodes, g.edges);
    expect(pos['m.a'].x - pos['m.main'].x).toBeLessThan(240 + 120);
  });
});

describe('positions per grouping mode', () => {
  it('switching mode swaps the two position sets', () => {
    const l = { ...emptyLayout(), nodes: { a: { x: 1, y: 1 } } };   // v0.1 layout = file mode
    const flat = withMode(l, 'flat');
    expect(flat.nodes).toEqual({});
    const moved = { ...flat, nodes: { a: { x: 9, y: 9 } } };
    const file = withMode(moved, 'file');
    expect(file.nodes).toEqual({ a: { x: 1, y: 1 } });
    expect(withMode(file, 'flat').nodes).toEqual({ a: { x: 9, y: 9 } });
    expect(withMode(file, 'file')).toBe(file);
  });
});
