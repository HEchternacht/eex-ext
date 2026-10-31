import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../../shared/graph';
import { DEFAULT_FILTERS, type Filters } from '../../shared/layout';
import { callChain, computeView, defaultCollapsed, levelVisible, matchesHidden, nodeRules, pathMatches, portGroups, portHandle, sideLevels, typeFamily } from './filters';
import { tooltipLines } from './panels/WireTooltip';
import { chainLayout } from './layout';

function node(id: string, kind: GraphNode['kind'] = 'function', parentId: string | null = null, file = 'C:/p/app/m.py'): GraphNode {
  return { id, kind, label: id.split('.').pop()!, module: 'm', qualname: id, parentId, file, range: { start: 1, end: 2, def: 1 },
    isAsync: false, ports: [{ id: 'in', name: 'in', dir: 'in', role: 'call', type: null }] };
}

function edge(kind: GraphEdge['kind'], source: string, target: string, level: 1 | 2 | 3, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${kind}|${source}|${target}`, kind, source, sourcePort: 'calls', target, targetPort: 'in', level,
    external: false, resolved: true, typeIn: null, typeOut: 'datetime', label: null, args: [], sites: [{ file: 'm.py', line: 3 }], ...extra };
}

const nodes = [
  node('m', 'module', null), node('m.A', 'class', 'm'), node('m.A.run', 'method', 'm.A'), node('m.A.get', 'method', 'm.A'),
  node('m.main', 'function', 'm'), node('m.getDate', 'function', 'm'), node('<imports>', 'imports'), node('<globals>', 'globals'),
];
const edges = [
  edge('call', 'm.main', 'm.getDate', 2),
  edge('method_call', 'm.main', 'm.A.run', 3),
  edge('method_call', 'm.A.run', 'm.A.get', 3),
  edge('call', 'm.main', '<imports>', 3, { external: true, targetPort: 'os.getcwd' }),
  edge('global_read', '<globals>', 'm.main', 3, { sourcePort: 'm.CONFIG' }),
  edge('depends', 'm.getDate', 'm.A.run', 2, { sourcePort: 'return', targetPort: 'arg:d', label: 'Depends' }),
];

function view(f: Partial<Filters> = {}, extra: Partial<Parameters<typeof computeView>[0]> = {}) {
  return computeView({ nodes, edges, layout: {}, filters: { ...DEFAULT_FILTERS, ...f }, lockedEdges: [], selected: null,
    levelMode: 'relative', edgeThreshold: 1000, ...extra });
}
const ids = (v: ReturnType<typeof view>) => v.edges.flatMap(e => e.edges.map(x => x.id)).sort();

describe('levels', () => {
  it('call wire is level 2 for caller, level 1 for callee', () => {
    const s = sideLevels(edges[0]);
    expect(s.src).toEqual({ in: 2, out: 2 });
    expect(s.tgt).toEqual({ in: 1, out: 1 });
  });

  it('relative: callee selected sees its arg/return wire at level 1', () => {
    const f = { ...DEFAULT_FILTERS, inputLevels: [1], outputLevels: [1] };
    expect(levelVisible(edges[0], f, 'm.getDate', 'relative')).toBe(true);
    expect(levelVisible(edges[0], f, 'm.main', 'relative')).toBe(false);
    expect(levelVisible(edges[0], f, null, 'relative')).toBe(false);
  });

  it('fixed: one level per wire, depends counts as 1', () => {
    const f = { ...DEFAULT_FILTERS, inputLevels: [1], outputLevels: [1] };
    expect(levelVisible(edges[5], f, null, 'fixed')).toBe(true);
    expect(levelVisible(edges[0], f, 'm.getDate', 'fixed')).toBe(false);
  });

  it('output-only level 3 hides level 2 calls', () => {
    const v = view({ inputLevels: [1, 2, 3], outputLevels: [3] });
    expect(ids(v)).not.toContain(edges[0].id);
    expect(ids(v)).toContain(edges[1].id);
  });
});

describe('filters', () => {
  it('shows everything by default', () => {
    expect(ids(view())).toEqual(edges.map(e => e.id).sort());
  });

  it('ignore_library_connections hides external wires and the imports node', () => {
    const v = view({ ignoreLibraryConnections: true });
    expect(ids(v)).not.toContain(edges[3].id);
    expect(v.nodes.map(n => n.id)).not.toContain('<imports>');
  });

  it('neighbours only keeps the selected node, its neighbours and their frames', () => {
    const v = view({ neighboursOnly: true }, { selected: 'm.getDate' });
    expect(v.nodes.map(n => n.id).sort()).toEqual(['m', 'm.A', 'm.A.run', 'm.getDate', 'm.main'].sort());
  });

  it('wires on demand shows only selected + locked wires', () => {
    expect(ids(view({ wiresOnDemand: true }))).toEqual([]);
    expect(ids(view({ wiresOnDemand: true }, { lockedEdges: [edges[2].id] }))).toEqual([edges[2].id]);
    expect(ids(view({ wiresOnDemand: true }, { selected: 'm.getDate' })).sort()).toEqual([edges[0].id, edges[5].id].sort());
  });

  it('wires on demand turns on automatically above the edge threshold', () => {
    expect(view({}, { edgeThreshold: 2 }).wiresOnDemand).toBe(true);
  });

  it('path filter', () => {
    expect(pathMatches('C:\\p\\app\\routers\\items.py', 'routers')).toBe(true);
    expect(pathMatches('C:/p/app/routers/items.py', '**/routers/*.py')).toBe(true);
    expect(pathMatches('C:/p/app/db/x.py', 'routers')).toBe(false);
  });
});

describe('collapse', () => {
  it('collapsed class reroutes wires to the frame and drops internal ones', () => {
    const v = view({}, { layout: { 'm.A': { x: 0, y: 0, collapsed: true } } });
    expect(v.nodes.map(n => n.id)).not.toContain('m.A.run');
    const toA = v.edges.find(e => e.target === 'm.A' && e.edges.some(x => x.kind === 'method_call'));
    expect(toA?.targetHandle).toBe('in');
    expect(toA?.rerouted).toBe(true);
    expect(ids(v)).not.toContain(edges[2].id);  // A.run -> A.get is internal
  });

  it('parents come before children', () => {
    const order = view().nodes.map(n => n.id);
    expect(order.indexOf('m')).toBeLessThan(order.indexOf('m.A'));
    expect(order.indexOf('m.A')).toBeLessThan(order.indexOf('m.A.run'));
  });

  it('big graphs start with classes collapsed', () => {
    expect(defaultCollapsed(nodes, {}, 1)).toContain('m.A');
    expect(defaultCollapsed(nodes, {}, 100)).toEqual([]);
  });
});

describe('tooltip', () => {
  it('shows type without a trace and value after one', () => {
    const e = edge('call', 'm.main', 'm.getDate', 2, { args: [{ expr: 'tz', type: 'str' }] });
    expect(tooltipLines(e)).toEqual([{ label: 'in tz', type: 'str', value: undefined }, { label: 'out', type: 'datetime', value: undefined }]);
    const lines = tooltipLines(e, { args: [{ name: 'tz', type: 'str', value: "'UTC'" }], ret: { type: 'datetime', value: '21/2/2026' }, history: [] });
    expect(lines[1]).toEqual({ label: 'out', type: 'datetime', value: '21/2/2026' });
  });
});

describe('port groups', () => {
  const imports: GraphNode = { ...node('<imports>', 'imports'), ports: ['asyncio.sleep', 'asyncio.Queue', 'os.getcwd', 'len'].map(id =>
    ({ id, name: id, dir: 'inout' as const, role: 'symbol' as const, type: null })) };
  const globals: GraphNode = { ...node('<globals>', 'globals'), ports: ['app.config.SETTINGS', 'app.config.KINDS', 'app.main.app'].map(id =>
    ({ id, name: id, dir: 'inout' as const, role: 'symbol' as const, type: null })) };

  it('libraries group by top package, globals by module', () => {
    expect(portGroups(imports).map(g => [g.key, g.ports.length])).toEqual([['asyncio', 2], ['os', 1], ['len', 1]]);
    expect(portGroups(globals).map(g => g.key)).toEqual(['app.config', 'app.main']);
  });

  it('closed groups share one handle; single-port groups and open groups use the port', () => {
    expect(portHandle(imports, 'asyncio.sleep', undefined)).toBe('group:asyncio');
    expect(portHandle(imports, 'os.getcwd', undefined)).toBe('os.getcwd');
    expect(portHandle(imports, 'asyncio.sleep', { x: 0, y: 0, openGroups: ['asyncio'] })).toBe('asyncio.sleep');
  });

  it('wires into a closed group merge onto the group handle', () => {
    const es = [
      edge('call', 'm.main', '<imports>', 3, { external: true, targetPort: 'asyncio.sleep' }),
      edge('call', 'm.getDate', '<imports>', 3, { external: true, targetPort: 'asyncio.Queue' }),
    ].map((e, i) => ({ ...e, id: `x${i}` }));
    const v = computeView({ nodes: [...nodes.filter(n => n.kind !== 'imports'), imports], edges: es, layout: {},
      filters: DEFAULT_FILTERS, lockedEdges: [], selected: null, levelMode: 'relative', edgeThreshold: 1000 });
    expect(v.edges.map(e => e.targetHandle)).toEqual(['group:asyncio', 'group:asyncio']);
  });
});

describe('filter menu rules', () => {
  const base = { nodes, edges, layout: {}, lockedEdges: [], selected: null, levelMode: 'relative' as const, edgeThreshold: 1000, root: 'C:/p' };
  const run = (hidden: string[], solo: string[] = [], extra = {}) =>
    computeView({ ...base, filters: { ...DEFAULT_FILTERS, hidden, solo }, ...extra });
  const nodeIds = (v: ReturnType<typeof run>) => v.nodes.map(n => n.id);

  it('node, file, folder and package rules', () => {
    const r = nodeRules(nodes.find(n => n.id === 'm.A.run')!, 'C:/p');
    expect(r.file).toEqual(['file:app/m.py', 'file:app/']);
    expect(r.pkg).toEqual(['pkg:m']);
    expect(nodeIds(run(['node:m.main']))).not.toContain('m.main');
    expect(nodeIds(run(['file:app/']))).toEqual([]);   // fixture specials have a file; real ones don't
  });

  it('hiding a frame keeps its members: they hang from the nearest shown ancestor', () => {
    const v = run(['kind:class']);
    expect(nodeIds(v)).not.toContain('m.A');
    expect(v.nodes.find(n => n.id === 'm.A.run')?.parentId).toBe('m');
    expect(ids(v)).toContain('method_call|m.main|m.A.run');
    const top = run(['kind:class', 'kind:module']);
    expect(top.nodes.find(n => n.id === 'm.A.run')?.parentId).toBe(null);
  });

  it('auto wires on demand counts only the wires that would show', () => {
    expect(view({}, { edgeThreshold: 4 }).autoWires).toBe(true);
    expect(view({ hidden: ['node:m.main'] }, { edgeThreshold: 4 }).autoWires).toBe(false);   // 2 wires left
  });

  it('calls through hidden nodes are bridged with a dashed via wire', () => {
    // main -> A.run -> A.get; hide A.run: main reaches A.get through it
    const v = view({ hidden: ['node:m.A.run'] }, { bridgeHidden: true });
    const via = v.edges.flatMap(e => e.edges).find(e => e.id === 'via|m.main|m.A.get')!;
    expect(via.label).toBe('via run');
    expect(via.resolved).toBe(false);
    // getDate is called directly by main: no extra via wire through A.run's Depends
    expect(ids(v)).not.toContain('via|m.main|m.getDate');
    expect(ids(view({ hidden: ['node:m.A.run'] }))).not.toContain('via|m.main|m.A.get');   // setting off
  });

  it('a hidden node passes data flow through: getDate -> run -> get becomes getDate -> get via run', () => {
    const flows = [
      edge('flow', 'm.getDate', 'm.A.run', 1, { sourcePort: 'return', targetPort: 'arg:d' }),
      edge('flow', 'm.A.run', 'm.A.get', 1, { sourcePort: 'return', targetPort: 'arg:x', label: 'via numpy.cumsum' }),
    ];
    const v = computeView({ nodes, edges: [...edges, ...flows], layout: {}, filters: { ...DEFAULT_FILTERS, hidden: ['node:m.A.run'] },
      lockedEdges: [], selected: null, levelMode: 'relative', edgeThreshold: 1000, bridgeHidden: true });
    const via = v.edges.flatMap(e => e.edges).find(e => e.id === 'via|flow|m.getDate|m.A.get|arg:x')!;
    expect(via).toMatchObject({ kind: 'flow', source: 'm.getDate', sourcePort: 'return', target: 'm.A.get', label: 'via run, numpy.cumsum' });
  });

  it('a folder rule covers only the files directly in it', () => {
    const deep = { ...nodes[4], id: 'm.deep', file: 'C:/p/app/core/d.py' };
    expect(nodeRules(deep, 'C:/p').file).toEqual(['file:app/core/d.py', 'file:app/core/']);
  });

  it('wire kind, flag and type rules hide wires only', () => {
    expect(ids(run(['wire:depends'])).some(id => id.startsWith('depends'))).toBe(false);
    expect(ids(run(['flag:library'])).some(id => id.includes('<imports>'))).toBe(false);
    expect(ids(run(['type:datetime']))).toEqual([]);   // every fixture wire returns datetime
  });

  it('solo keeps only matches within its category', () => {
    expect(ids(run([], ['wire:depends']))).toEqual(['depends|m.getDate|m.A.run']);
    expect(nodeIds(run([], ['kind:method']))).toEqual(expect.arrayContaining(['m.A.run', 'm.A.get']));
    expect(nodeIds(run([], ['kind:method']))).not.toContain('m.main');
  });

  it('matchesHidden: hidden wins, solo per category', () => {
    const rules = { kind: ['kind:function'], file: ['file:a.py', 'file:'] };
    expect(matchesHidden(rules, new Set(['kind:function']), [])).toBe(true);
    expect(matchesHidden(rules, new Set(), ['kind:method'])).toBe(true);
    expect(matchesHidden(rules, new Set(), ['kind:function', 'kind:method'])).toBe(false);
    expect(typeFamily('Optional[list[int]]')).toBe('list');
    expect(typeFamily('app.models.Frame | None')).toBe('Frame');
  });

  it('focus: only inputs / only outputs / both ends of a wire', () => {
    const inOnly = ids(run([], [], { focus: { node: 'm.A.run', dir: 'in' } }));
    expect(inOnly.every(id => id.split('|')[2] === 'm.A.run')).toBe(true);
    const out = ids(run([], [], { focus: { node: 'm.main', dir: 'out' } }));
    expect(out.length).toBe(3);
    const ends = run([], [], { focus: { edge: 'call|m.main|m.getDate' } });
    expect(ids(ends)).toEqual(['call|m.main|m.getDate']);
    expect(nodeIds(ends).filter(id => !id.startsWith('<'))).toEqual(expect.arrayContaining(['m.main', 'm.getDate']));
  });

  it('follow forward / backward: the transitive call chain, Depends reversed, hubs end it', () => {
    const byId = new Map(nodes.map(n => [n.id, n]));
    expect(Object.fromEntries(callChain(edges, byId, 'm.main', 'forward')))
      .toEqual({ 'm.main': 0, 'm.getDate': 1, 'm.A.run': 1, '<imports>': 1, 'm.A.get': 2 });
    // getDate is called by main, and (through Depends) by A.run, which main calls
    expect(Object.fromEntries(callChain(edges, byId, 'm.getDate', 'backward'))).toEqual({ 'm.getDate': 0, 'm.main': 1, 'm.A.run': 1 });
    // a class follows from all its methods
    expect([...callChain(edges, byId, 'm.A', 'forward').keys()].sort()).toEqual(['m.A', 'm.A.get', 'm.A.run', 'm.getDate']);
    const v = run([], [], { focus: { node: 'm.getDate', chain: 'backward' } });
    expect(nodeIds(v).sort()).toEqual(['m.A.run', 'm.getDate', 'm.main']);   // no frames: packed freely
    expect(v.nodes.every(n => n.parentId === null)).toBe(true);
    expect(ids(v)).toEqual(['call|m.main|m.getDate', 'depends|m.getDate|m.A.run', 'method_call|m.main|m.A.run']);
  });

  it('chain layout: callers left, callees right, columns packed and centred', () => {
    const flat = new Map(nodes.map(n => [n.id, { ...n, parentId: null }]));
    const chain = new Map([['m.main', 0], ['m.getDate', 1], ['m.A.run', 1], ['m.A.get', 2]]);
    const pos = chainLayout(chain, 'forward', flat, () => ({ w: 100, h: 40 }));
    expect(pos['m.main'].x).toBeLessThan(pos['m.getDate'].x);
    expect(pos['m.getDate'].x).toBe(pos['m.A.run'].x);
    expect(pos['m.A.get'].x).toBeGreaterThan(pos['m.A.run'].x);
    expect(pos['m.main'].y).toBe((pos['m.getDate'].y + pos['m.A.run'].y) / 2);   // centred on the taller column
    const back = chainLayout(chain, 'backward', flat, () => ({ w: 100, h: 40 }));
    expect(back['m.A.get'].x).toBeLessThan(back['m.main'].x);
    // nested nodes move with their top-level frame
    const nested = chainLayout(chain, 'forward', new Map(nodes.map(n => [n.id, n])), () => ({ w: 100, h: 40 }));
    expect(Object.keys(nested)).toEqual(['m']);
  });
});
