import { create } from 'zustand';
import { Graph, GraphEdge, GraphPatch, applyPatch } from '../../shared/graph';
import { Filters, LayoutState, NodeLayout, emptyLayout, normalizeLayout, withMode } from '../../shared/layout';
import type { CanvasSettings, InjectResult, PauseInfo, TraceEvent, TracedValue } from '../../shared/protocol';
import { defaultCollapsed, type Focus } from './filters';
import { autoLayout, regroup } from './layout';
import { post } from './vscode';

export interface WireValues {
  args?: ({ name: string } & TracedValue)[];
  ret?: TracedValue;
  history: { args?: WireValues['args']; ret?: WireValues['ret'] }[];
}

export interface BallRequest { seq: number; edge: string; t: 'call' | 'return'; stepMs?: number }

export interface LogEntry {
  seq: number;
  ts: number;
  kind: 'call' | 'return' | 'global' | 'pause' | 'inject' | 'error' | 'info';
  node?: string;
  caller?: string;
  depth: number;
  text: string;          // arguments / value / message
  ms?: number;           // return: approximate duration
}

export interface NodeStats { calls: number; lastTs: number; startTs?: number; lastMs?: number }

interface State {
  raw: Graph | null;                          // as analysed
  graph: Graph | null;                        // as drawn (regrouped for the current grouping mode)
  layout: LayoutState;
  settings: CanvasSettings;
  selected: string | null;
  selectedEdge: string | null;                // wire shown in the inspector
  inspector: boolean;                         // inspector panel open
  stats: Record<string, NodeStats>;           // node id -> trace counters
  edgeCalls: Record<string, number>;          // graph edge id -> calls seen
  sources: Record<string, { text: string; start: number }>;  // node id -> source (inspector)
  ballQueue: BallRequest[];                   // recent wire steps for the ball animation (BallLayer consumes)
  log: LogEntry[];                            // footer log, capped by settings.logMax
  follow: boolean;                            // follow mode: the program waits for each step's animation
  followHold: boolean;                        // follow paused by the user: steps are not acknowledged
  followStepMs: number | null;                // speed slider (null = setting)
  pauses: PauseInfo[];                        // steps the traced program is waiting on
  visibleIds: string[];                       // nodes in the current view (follow scope 'filtered')
  injectFor: string | null;                   // node whose inject form is open
  injectResults: InjectResult[];
  focus: Focus | null;                        // context menu "show only ..." (not persisted)
  chainRequest: { node: string; dir: 'forward' | 'backward'; seq: number } | null;   // from the editor menu (Canvas runs it)
  arranged: Record<string, Partial<NodeLayout>> | null;
  fitTo: string[] | null;
  autoWires: boolean;                         // the current view has too many wires: wires on demand (FilterBar)                     // fit the view to these nodes once they are rendered and measured   // temporary chain positions (cleared with the focus)
  hoverEdge: { id: string; x: number; y: number } | null;
  status: { text: string; busy: boolean };
  traceRunning: boolean;
  edgeValues: Record<string, WireValues>;     // graph edge id -> last values
  nodeValues: Record<string, WireValues>;
  glow: Record<string, number>;               // node id -> timestamp
  pulse: Record<string, number>;              // graph edge id -> timestamp
  layoutTick: number;                         // bumps when positions change from outside React Flow
  firstSeen: Map<string, number>;             // node id -> order of first call in the trace (layout column order)

  init(graph: Graph, layout: LayoutState, settings: CanvasSettings): Promise<void>;
  applyPatch(p: GraphPatch): Promise<void>;
  setLayout(layout: LayoutState): Promise<void>;
  setSettings(s: CanvasSettings, f?: Partial<Filters>): void;
  setFilters(f: Partial<Filters>): void;
  select(id: string | null): void;
  selectEdge(id: string | null): void;
  setInspector(open: boolean): void;
  setSource(id: string, text: string, start: number): void;
  setFocus(f: Focus | null): void;
  arrange(pos: Record<string, Partial<NodeLayout>>): void;
  hideRule(rule: string): void;
  hover(h: State['hoverEdge']): void;
  moveNode(id: string, pos: NodeLayout): void;
  dragNode(id: string, x: number, y: number): void;   // user drag: moves a packed node within the packing
  toggleCollapse(id: string): void;
  setCollapsed(ids: string[], collapsed: boolean): void;
  toggleLock(edgeId: string): void;
  toggleGroup(nodeId: string, group: string): void;
  setViewport(v: LayoutState['viewport']): void;
  applyTrace(events: TraceEvent[]): void;
  setStatus(text: string, busy: boolean): void;
  setTraceRunning(r: boolean): void;
  toggleIntercept(id: string): void;
  setFollow(on: boolean): void;
  setFollowHold(hold: boolean): void;
  setFollowStepMs(ms: number | null): void;
  sendControl(): void;
  addPause(p: PauseInfo): void;
  answerPause(key: string, how: 'resume' | 'abort', args?: Record<string, string>): void;
  dropPause(key: string): void;
  setVisibleIds(ids: string[]): void;
  openInject(id: string | null): void;
  addInjectResult(r: InjectResult): void;
  addLog(e: Omit<LogEntry, 'seq' | 'ts' | 'depth'> & { ts?: number; depth?: number }): void;
  clearLog(): void;
  relayout(): Promise<void>;
}

const DEFAULT_SETTINGS: CanvasSettings = { collapseThreshold: 300, edgeThreshold: 300, glowMs: 600, levelMode: 'relative', history: 1, groupByFile: false, maxBalls: 30, logMax: 5000, logShowHidden: false, bridgeHidden: true,
  colorScheme: 'vscode', showGuide: false, followStepMs: 500, followScope: 'filtered', followCamera: 'pan', pack: 'temporary' };

const modeOf = (s: CanvasSettings) => (s.groupByFile ? 'file' : 'flat');

function persist(layout: LayoutState) {
  post({ type: 'layout', layout });
}

/**
 * Positions for nodes that have none (existing positions are kept). Returns only the additions so the
 * caller can merge them into whatever the layout is once ELK finishes (it may have changed meanwhile).
 */
async function placeNew(graph: Graph, layout: LayoutState, threshold: number): Promise<Record<string, NodeLayout>> {
  const missing = graph.nodes.filter(n => !layout.nodes[n.id]);
  if (!missing.length) return {};
  const computed = await autoLayout(graph.nodes, graph.edges, useStore.getState().firstSeen);
  const add: Record<string, NodeLayout> = {};
  for (const n of missing) add[n.id] = computed[n.id] ?? { x: 0, y: 0 };
  // containers grow to ELK's size if they got new children
  for (const [id, c] of Object.entries(computed)) {
    const cur = layout.nodes[id];
    if (cur && c.w && c.h && (cur.w ?? 0) < c.w) add[id] = { ...cur, w: c.w, h: Math.max(cur.h ?? 0, c.h) };
  }
  for (const id of defaultCollapsed(graph.nodes, layout.nodes, threshold)) add[id] = { ...add[id], collapsed: true };
  return add;
}

function merge(layout: LayoutState, add: Record<string, NodeLayout>): LayoutState {
  const ids = Object.keys(add);
  if (!ids.length) return layout;
  const nodes = { ...layout.nodes };
  for (const id of ids) {
    const cur = nodes[id];
    const a = add[id];
    if (!cur) nodes[id] = a;
    else nodes[id] = {
      ...cur,
      ...(a.w && (cur.w ?? 0) < a.w ? { w: a.w, h: Math.max(cur.h ?? 0, a.h ?? 0) } : {}),
      ...(cur.collapsed === undefined && a.collapsed ? { collapsed: true } : {}),
    };
  }
  return { ...layout, nodes };
}

export const useStore = create<State>((set, get) => ({
  raw: null,
  graph: null,
  layout: emptyLayout(),
  settings: DEFAULT_SETTINGS,
  selected: null,
  selectedEdge: null,
  inspector: true,
  stats: {},
  edgeCalls: {},
  sources: {},
  ballQueue: [],
  log: [],
  follow: false,
  followHold: false,
  followStepMs: null,
  pauses: [],
  visibleIds: [],
  injectFor: null,
  injectResults: [],
  focus: null,
  arranged: null,
  fitTo: null,
  autoWires: false,
  chainRequest: null,
  hoverEdge: null,
  status: { text: 'Waiting for analysis…', busy: true },
  traceRunning: false,
  edgeValues: {},
  nodeValues: {},
  glow: {},
  pulse: {},
  layoutTick: 0,
  firstSeen: new Map(),

  async init(raw, saved, settings) {
    const graph = regroup(raw, settings.groupByFile);
    const layout = withMode(normalizeLayout(saved), modeOf(settings));
    set({ status: { text: 'Laying out…', busy: true }, settings, layout, raw });
    const add = await placeNew(graph, layout, settings.collapseThreshold);
    const placed = merge(get().layout, add);
    set(s => ({ graph, layout: placed, layoutTick: s.layoutTick + 1,
      status: { text: `${graph.nodes.length} nodes · ${graph.edges.length} wires`, busy: false } }));
    if (Object.keys(add).length || layout !== saved) persist(placed);
    get().sendControl();   // persisted intercepts apply to the next traced run
  },

  async applyPatch(p) {
    const r = get().raw;
    if (!r) return;
    const raw = applyPatch(r, p);
    const graph = regroup(raw, get().settings.groupByFile);
    const add = await placeNew(graph, get().layout, get().settings.collapseThreshold);
    const placed = merge(get().layout, add);
    set(s => ({ raw, graph, layout: placed, layoutTick: s.layoutTick + 1 }));
    if (Object.keys(add).length) persist(placed);
  },

  async setLayout(incoming) {
    const layout = withMode(normalizeLayout(incoming), modeOf(get().settings));
    set(s => ({ layout, layoutTick: s.layoutTick + 1 }));
    persist(layout);
    get().sendControl();   // an imported layout may bring intercepts
    const g = get().graph;
    const add = g ? await placeNew(g, layout, get().settings.collapseThreshold) : {};
    if (!Object.keys(add).length) return;
    const placed = merge(get().layout, add);
    set(s => ({ layout: placed, layoutTick: s.layoutTick + 1 }));
    persist(placed);
  },

  setSettings(settings, f) {
    const regrouped = settings.groupByFile !== get().settings.groupByFile;
    set({ settings });
    if (f) get().setFilters(f);
    if (regrouped && get().raw) {
      set({ graph: regroup(get().raw!, settings.groupByFile) });
      void get().setLayout(get().layout);
    }
  },

  setFilters(f) {
    const layout = { ...get().layout, filters: { ...get().layout.filters, ...f } };
    set(s => ({ layout, arranged: null, layoutTick: s.arranged ? s.layoutTick + 1 : s.layoutTick }));   // packed positions belong to the old view
    persist(layout);
  },

  select(id) {
    set({ selected: id, selectedEdge: null });
  },

  selectEdge(selectedEdge) {
    set({ selectedEdge, inspector: true });
  },

  setInspector(inspector) {
    set({ inspector });
  },

  setSource(id, text, start) {
    set(s => ({ sources: { ...s.sources, [id]: { text, start } } }));
  },

  setFocus(focus) {
    set(s => ({ focus, arranged: null, layoutTick: s.arranged ? s.layoutTick + 1 : s.layoutTick }));
  },

  arrange(pos) {
    if (get().settings.pack !== 'keep') {
      set(s => ({ arranged: pos, layoutTick: s.layoutTick + 1 }));
      return;
    }
    const nodes = { ...get().layout.nodes };
    for (const [id, p] of Object.entries(pos)) nodes[id] = { ...nodes[id], ...p };
    const layout = { ...get().layout, nodes };
    set(s => ({ layout, layoutTick: s.layoutTick + 1 }));
    persist(layout);
  },

  hideRule(rule) {
    const hidden = get().layout.filters.hidden;
    if (!hidden.includes(rule)) get().setFilters({ hidden: [...hidden, rule] });
  },

  hover(h) {
    set({ hoverEdge: h });
  },

  dragNode(id, x, y) {
    const a = get().arranged;
    if (a?.[id]) set({ arranged: { ...a, [id]: { ...a[id], x, y } } });
    else get().moveNode(id, { ...get().layout.nodes[id], x, y });
  },

  moveNode(id, pos) {
    const layout = { ...get().layout, nodes: { ...get().layout.nodes, [id]: { ...get().layout.nodes[id], ...pos } } };
    set({ layout });
    persist(layout);
  },

  toggleCollapse(id) {
    const cur = get().layout.nodes[id];
    get().setCollapsed([id], !cur?.collapsed);
  },

  setCollapsed(ids, collapsed) {
    const nodes = { ...get().layout.nodes };
    for (const id of ids) nodes[id] = { ...(nodes[id] ?? { x: 0, y: 0 }), collapsed };
    const layout = { ...get().layout, nodes };
    set({ layout });
    persist(layout);
  },

  toggleGroup(nodeId, group) {
    const cur = get().layout.nodes[nodeId] ?? { x: 0, y: 0 };
    const open = cur.openGroups ?? [];
    get().moveNode(nodeId, { ...cur, openGroups: open.includes(group) ? open.filter(g => g !== group) : [...open, group] });
  },

  toggleLock(edgeId) {
    const cur = get().layout.lockedEdges;
    const lockedEdges = cur.includes(edgeId) ? cur.filter(e => e !== edgeId) : [...cur, edgeId];
    const layout = { ...get().layout, lockedEdges };
    set({ layout });
    persist(layout);
  },

  setViewport(viewport) {
    const layout = { ...get().layout, viewport };
    set({ layout });
    persist(layout);
  },

  applyTrace(events) {
    const g = get().graph;
    if (!g) return;
    const historyMax = Math.max(1, get().settings.history);
    const index = edgeIndex(g.edges);
    const edgeValues = { ...get().edgeValues };
    const nodeValues = { ...get().nodeValues };
    const glow = { ...get().glow };
    const pulse = { ...get().pulse };
    const now = performance.now();
    const firstSeen = get().firstSeen;
    const stats = { ...get().stats };
    const balls: BallRequest[] = [];
    const logs: LogEntry[] = [];
    let logSeq = get().log.at(-1)?.seq ?? 0;
    let seq = get().ballQueue.at(-1)?.seq ?? 0;
    const edgeCalls = { ...get().edgeCalls };
    for (const ev of events) {
      if (ev.t === 'call' || ev.t === 'return') {
        const cur = (stats[ev.node] = { ...(stats[ev.node] ?? { calls: 0, lastTs: 0 }) });
        cur.lastTs = ev.ts;
        if (ev.t === 'call') {
          cur.calls += ev.count ?? 1;
          cur.startTs = ev.ts;
        } else if (cur.startTs !== undefined) cur.lastMs = Math.max(0, ev.ts - cur.startTs);
      }
      if (ev.t === 'call' && !firstSeen.has(ev.node)) firstSeen.set(ev.node, firstSeen.size);
      glow[ev.node] = now;
      const shortArgs = ev.args?.map(a => `${a.name}=${a.value}`).join(', ') ?? '';
      logs.push({
        seq: ++logSeq, ts: ev.ts, kind: ev.t, node: ev.node, caller: ev.callers?.[0] ?? ev.caller ?? undefined, depth: ev.callers?.length ?? 0,
        text: ev.t === 'call' ? shortArgs : `${ev.port ? ev.port + ' = ' : ''}${ev.value?.value ?? ''}`,
        ms: ev.t === 'return' ? stats[ev.node]?.lastMs : undefined,
      });
      const nv = (nodeValues[ev.node] = { ...(nodeValues[ev.node] ?? { history: [] }) });
      if (ev.t === 'call') nv.args = ev.args;
      if (ev.t === 'return') nv.ret = ev.value;
      if (ev.t === 'global' && ev.port) {
        for (const e of g.edges) {
          if ((e.sourcePort === ev.port || e.targetPort === ev.port) && (e.source === ev.node || e.target === ev.node)) {
            pulse[e.id] = now;
            edgeValues[e.id] = { ret: ev.value, history: [] };
          }
        }
        continue;
      }
      // first caller in the chain that has a static wire to this node (skips decorator wrappers)
      const chain = ev.callers?.length ? ev.callers : ev.caller ? [ev.caller] : [];
      const ids = chain.map(c => index.get(`${c}>${ev.node}`)).find(x => x?.length) ?? [];
      for (const id of ids) {
        pulse[id] = now;
        if (ev.t === 'call') edgeCalls[id] = (edgeCalls[id] ?? 0) + (ev.count ?? 1);
        // in follow mode the balls come from the paused steps (driver.ts), at follow speed
        if ((ev.t === 'call' || ev.t === 'return') && !get().follow) balls.push({ seq: ++seq, edge: id, t: ev.t });
        const ev2 = (edgeValues[id] = { ...(edgeValues[id] ?? { history: [] }) });
        if (ev.t === 'call') ev2.args = ev.args;
        else ev2.ret = ev.value;
        if (ev.t === 'return') ev2.history = [...ev2.history, { args: ev2.args, ret: ev2.ret }].slice(-historyMax);
      }
      // data flow into this call: wires from producers that have returned a value
      if (ev.t === 'call') {
        for (const key of index.get(`<flow>${ev.node}`) ?? []) {
          const [src, id] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
          if (!nodeValues[src]?.ret) continue;
          pulse[id] = now;
          if (!get().follow) balls.push({ seq: ++seq, edge: id, t: 'call' });
          edgeValues[id] = { history: edgeValues[id]?.history ?? [], ret: nodeValues[src].ret, args: ev.args };
        }
      }
    }
    set({ edgeValues, nodeValues, glow, pulse, stats, edgeCalls, ballQueue: [...get().ballQueue, ...balls].slice(-200),
      log: [...get().log, ...logs].slice(-get().settings.logMax) });
  },

  setStatus(text, busy) {
    set({ status: { text, busy } });
    if (!busy) get().addLog({ kind: /fail|error/i.test(text) ? 'error' : 'info', text });
  },

  toggleIntercept(id) {
    const cur = get().layout.intercepts ?? [];
    const intercepts = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    const layout = { ...get().layout, intercepts };
    set({ layout });
    persist(layout);
    get().sendControl();
  },

  setFollow(follow) {
    set({ follow, followHold: false });
    get().sendControl();
    // leaving follow mode: release whatever is waiting on an animation
    if (!follow) for (const p of get().pauses.filter(x => x.reason === 'follow')) get().answerPause(p.key, 'resume');
  },

  setFollowHold(followHold) {
    set({ followHold });
  },

  setFollowStepMs(followStepMs) {
    set({ followStepMs });
  },

  sendControl() {
    const s = get();
    let followNodes: string[] | null = null;
    if (s.settings.followScope === 'filtered') followNodes = s.visibleIds;
    else if (s.settings.followScope === 'selected') {
      const sel = s.selected;
      followNodes = sel ? [sel, ...(s.graph?.edges ?? []).filter(e => e.source === sel || e.target === sel).flatMap(e => [e.source, e.target])] : [];
    }
    post({ type: 'traceControl', control: { intercept: s.layout.intercepts ?? [], follow: s.follow, followNodes } });
  },

  addPause(p) {
    set(s => ({ pauses: [...s.pauses.filter(x => x.key !== p.key), p] }));
    get().addLog({ kind: 'pause', node: p.node, caller: p.callers[0], depth: p.callers.length, ts: p.ts,
      text: `${p.reason === 'intercept' ? 'intercepted' : 'step'} · ${p.t}${p.args ? ' ' + p.args.map(a => `${a.name}=${a.value}`).join(', ') : p.value ? ' → ' + p.value.value : ''}` });
  },

  answerPause(key, how, args) {
    if (how === 'abort') post({ type: 'abort', key });
    else post({ type: 'resume', key, args });
    get().dropPause(key);
  },

  dropPause(key) {
    set(s => ({ pauses: s.pauses.filter(x => x.key !== key) }));
  },

  setVisibleIds(visibleIds) {
    set({ visibleIds });
  },

  openInject(injectFor) {
    set({ injectFor });
  },

  addInjectResult(r) {
    set(s => ({ injectResults: [...s.injectResults, r].slice(-50) }));
    get().addLog({ kind: r.ok ? 'inject' : 'error', node: r.node, text: r.ok ? `${r.where} inject → ${r.value?.value ?? ''}` : `${r.where} inject failed: ${r.error}` });
  },

  addLog(e) {
    const last = get().log.at(-1);
    const entry: LogEntry = { depth: 0, ...e, ts: e.ts ?? Date.now(), seq: (last?.seq ?? 0) + 1 };
    set({ log: [...get().log, entry].slice(-get().settings.logMax) });
  },

  clearLog() {
    set({ log: [] });
  },

  setTraceRunning(traceRunning) {
    set({ traceRunning });
  },

  async relayout() {
    const keep = Object.fromEntries(Object.entries(get().layout.nodes)
      .filter(([, l]) => l.collapsed !== undefined).map(([id, l]) => [id, { collapsed: l.collapsed } as NodeLayout]));
    const g = get().graph;
    if (!g) return;
    const computed = await autoLayout(g.nodes, g.edges, get().firstSeen);
    const nodes: Record<string, NodeLayout> = {};
    for (const n of g.nodes) nodes[n.id] = { ...(computed[n.id] ?? { x: 0, y: 0 }), ...keep[n.id] };
    const layout = { ...get().layout, nodes };
    set(s => ({ layout, layoutTick: s.layoutTick + 1 }));
    persist(layout);
  },
}));

let cachedIndex: { edges: GraphEdge[]; map: Map<string, string[]> } | null = null;

/** caller>callee -> edge ids, for mapping trace events onto wires. Depends wires are drawn provider->consumer.
 * <flow>consumer -> 'producer|edge id' (data-flow wires). */
export function edgeIndex(edges: GraphEdge[]): Map<string, string[]> {
  if (cachedIndex?.edges === edges) return cachedIndex.map;
  const map = new Map<string, string[]>();
  const add = (k: string, id: string) => map.set(k, [...(map.get(k) ?? []), id]);
  for (const e of edges) {
    if (e.kind === 'call' || e.kind === 'method_call' || e.kind === 'reference') add(`${e.source}>${e.target}`, e.id);
    else if (e.kind === 'depends') add(`${e.target}>${e.source}`, e.id);
    else if (e.kind === 'flow') add(`<flow>${e.target}`, `${e.source}|${e.id}`);
  }
  cachedIndex = { edges, map };
  return map;
}
