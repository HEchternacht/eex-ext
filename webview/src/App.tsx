import {
  Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FromWebview, ToWebview } from '../../shared/protocol';
import { BallLayer } from './edges/BallLayer';
import { FlowEdge, type FlowEdgeData } from './edges/FlowEdge';
import { computeView, type ViewEdge } from './filters';
import { NODE_W, leafSize } from './layout';
import { CodeNode, SpecialNode, type CodeNodeData } from './nodes/CodeNode';
import { useActions } from './actions';
import { useTraceDriver } from './driver';
import { ContextMenu, type MenuState } from './panels/ContextMenu';
import { FilterBar } from './panels/FilterBar';
import { InjectDialog } from './panels/Debug';
import { GuideOverlay, Legend } from './panels/Guide';
import { Inspector } from './panels/Inspector';
import { LogPanel } from './panels/LogPanel';
import { NodeCard, useDelayedHover } from './panels/NodeCard';
import { WireTooltip, tooltipLines } from './panels/WireTooltip';
import { useStore } from './store';
import { post } from './vscode';

const nodeTypes = { code: CodeNode, special: SpecialNode };
const edgeTypes = { flow: FlowEdge };
const SPECIAL = new Set(['imports', 'globals', 'unresolved']);

function Canvas() {
  const s = useStore();
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const fitted = useRef(false);
  const card = useDelayedHover();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [guide, setGuide] = useState(false);
  const showGuide = useStore(x => x.settings.showGuide);
  useEffect(() => { if (showGuide) setGuide(true); }, [showGuide]);
  const closeGuide = () => {
    setGuide(false);
    if (showGuide) post({ type: 'guideSeen' });
  };
  const hc = typeof document !== 'undefined' && document.body.classList.contains('vscode-high-contrast');
  const scheme = s.settings.colorScheme === 'vscode' && hc ? 'high-contrast' : s.settings.colorScheme;
  (window as unknown as { __codeflow: unknown }).__codeflow = { rf, store: useStore };  // debugging / automation

  const view = useMemo(() => s.graph && computeView({
    nodes: s.graph.nodes, edges: s.graph.edges, layout: s.layout.nodes, filters: s.layout.filters,
    lockedEdges: s.layout.lockedEdges, selected: s.selected, levelMode: s.settings.levelMode,
    edgeThreshold: s.settings.edgeThreshold, root: s.graph.root, focus: s.focus, bridgeHidden: s.settings.bridgeHidden,
  }), [s.graph, s.layout.nodes, s.layout.filters, s.layout.lockedEdges, s.selected, s.settings, s.focus]);

  const childCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of s.graph?.nodes ?? []) if (n.parentId) m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1);
    return m;
  }, [s.graph]);
  const parents = useMemo(() => new Set(childCount.keys()), [childCount]);

  // rebuild React Flow nodes when the view or saved positions change
  useEffect(() => {
    if (!view) return;
    const viewParents = new Set(view.nodes.map(n => n.parentId));
    setNodes(view.nodes.map(n => {
      const l = { ...(s.layout.nodes[n.id] ?? { x: 0, y: 0 }), ...s.arranged?.[n.id] };
      const hasChildren = parents.has(n.id);
      const collapsed = !!l.collapsed;
      const size = leafSize(n, l);
      const container = viewParents.has(n.id) && !collapsed;   // a frame whose children are all hidden is drawn as a node
      return {
        id: n.id,
        type: SPECIAL.has(n.kind) ? 'special' : 'code',
        position: { x: l.x, y: l.y },
        parentId: n.parentId ?? undefined,
        expandParent: true,
        selected: s.selected === n.id,
        data: { node: n, hasChildren, collapsed, childCount: childCount.get(n.id) ?? 0 } satisfies CodeNodeData,
        style: container
          ? { width: l.w ?? NODE_W * 1.5, height: l.h ?? size.h * 3 }
          : { width: size.w },
      };
    }));
  }, [view, s.layoutTick, parents]); // eslint-disable-line react-hooks/exhaustive-deps

  const edgeMap = useMemo(() => new Map<string, ViewEdge>(view?.edges.map(e => [e.id, e]) ?? []), [view]);
  const toView = useMemo(() => new Map(view?.edges.flatMap(v => v.edges.map(e => [e.id, v.id] as [string, string])) ?? []), [view]);
  const locked = useMemo(() => new Set(s.layout.lockedEdges), [s.layout.lockedEdges]);
  const edges: Edge[] = useMemo(() => (view?.edges ?? []).map(e => ({
    id: e.id, type: 'flow', source: e.source, target: e.target,
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
    data: { view: e, locked: e.edges.some(x => locked.has(x.id)) } satisfies FlowEdgeData,
  })), [view, locked]);

  // report what is rendered (tests / automation)
  useEffect(() => {
    if (!view) return;
    const t = setTimeout(() => post(lastReport = { type: 'rendered', visibleNodes: view.nodes.map(n => n.id), visibleEdges: view.edges.flatMap(e => e.edges.map(x => x.id)) }), 150);
    return () => clearTimeout(t);
  }, [view]);

  useEffect(() => {
    if (!view || fitted.current || !nodes.length) return;
    fitted.current = true;
    const vp = useStore.getState().layout.viewport;
    setTimeout(() => (vp ? rf.setViewport(vp) : rf.fitView({ padding: 0.1 })), 50);
  }, [view, nodes.length, rf]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(ns => applyNodeChanges(changes, ns));
    for (const c of changes) {
      if (c.type === 'dimensions' && c.resizing === false && c.dimensions) {
        const cur = useStore.getState().layout.nodes[c.id];
        if (cur) useStore.getState().moveNode(c.id, { ...cur, w: c.dimensions.width, h: c.dimensions.height });
      }
    }
  }, []);

  const onCollapseAll = (collapsed: boolean) => {
    if (s.graph) s.setCollapsed([...parents], collapsed);
  };
  const actions = useActions(onCollapseAll);
  const driver = useTraceDriver();
  const chainRequest = useStore(x => x.chainRequest);
  // fit to a node set (follow chain) once React Flow has those nodes measured at their new positions
  const fitTo = useStore(x => x.fitTo);
  useEffect(() => {
    if (!fitTo) return;
    const want = new Map(nodes.filter(n => fitTo.includes(n.id)).map(n => [n.id, n.position]));
    if (!want.size) return;
    let frame = 0, tries = 0;
    const attempt = () => {
      const ready = [...want].every(([id, p]) => {
        const n = rf.getInternalNode(id);
        return n?.measured.width && n.position.x === p.x && n.position.y === p.y;
      });
      if (!ready && ++tries < 60) { frame = requestAnimationFrame(attempt); return; }
      useStore.setState({ fitTo: null });
      void rf.fitView({ nodes: [...want.keys()].map(id => ({ id })), padding: 0.1, duration: 300 });
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [fitTo, nodes, rf]);
  const chainDone = useRef(0);
  useEffect(() => {   // waits for the graph when the canvas was just opened by the request
    if (!chainRequest || chainRequest.seq === chainDone.current || !s.graph || !view?.nodes.length) return;
    chainDone.current = chainRequest.seq;
    actions.followChain(chainRequest.node, chainRequest.dir);
  }, [chainRequest?.seq, s.graph, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // follow scope: re-send the paused-on nodes when the view (filtered) or the selection (selected) changes
  useEffect(() => {
    if (!view) return;
    s.setVisibleIds(view.nodes.map(n => n.id));
    if (useStore.getState().autoWires !== view.autoWires) useStore.setState({ autoWires: view.autoWires });
    if (!useStore.getState().follow) return;
    const t = setTimeout(() => useStore.getState().sendControl(), 200);
    return () => clearTimeout(t);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('keydown', actions.onKey);
    return () => window.removeEventListener('keydown', actions.onKey);
  }, [actions.onKey]);
  const openMenu = (e: { preventDefault(): void; clientX: number; clientY: number }, items: MenuState['items']) => {
    e.preventDefault();
    card.leave();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="cf-root" data-scheme={scheme}>
      <FilterBar onFit={() => void actions.fit()} onCollapseAll={onCollapseAll} onGuide={() => setGuide(true)} onStep={driver.step} />
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <marker id="cf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="cf-arrow" />
          </marker>
          <marker id="cf-arrow-rev" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="cf-arrow" />
          </marker>
        </defs>
      </svg>
      <div className="cf-main">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node, dragged) => {
          for (const n of dragged.length ? dragged : [node]) s.dragNode(n.id, n.position.x, n.position.y);
        }}
        onNodeClick={(_, n) => s.select(n.id)}
        onNodeDoubleClick={(e, n) => { e.stopPropagation(); post({ type: 'openNode', id: n.id }); }}
        onPaneClick={() => s.select(null)}
        onEdgeClick={(e, edge) => { const v = edgeMap.get(edge.id); if (v) actions.follow(v.edges[0], e.altKey); }}
        onNodeContextMenu={(e, n) => { const g = s.graph?.nodes.find(x => x.id === n.id); if (g) { s.select(g.id); openMenu(e, actions.nodeMenu(g)); } }}
        onEdgeContextMenu={(e, edge) => { const v = edgeMap.get(edge.id); if (v) openMenu(e, actions.edgeMenu(v)); }}
        onPaneContextMenu={e => openMenu(e, actions.paneMenu())}
        onNodeMouseEnter={(e, n) => card.enter(n.id, e.clientX, e.clientY)}
        onNodeMouseLeave={() => card.leave()}
        onNodeDragStart={() => card.leave()}
        onMoveEnd={(_, vp) => s.setViewport(vp)}
        minZoom={0.05}
        maxZoom={3}
        onlyRenderVisibleElements
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <BallLayer toView={toView} />
        <Panel position="bottom-left" className="cf-legend-panel"><Legend /></Panel>
        <MiniMap pannable zoomable className="cf-minimap" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {s.inspector
        ? <Inspector onGo={actions.goTo} />
        : <button className="cf-insp-open" title="Open inspector" onClick={() => s.setInspector(true)}><i className="codicon codicon-inspect" /></button>}
      </div>
      <LogPanel onGo={actions.goTo} />
      {guide && <GuideOverlay onClose={closeGuide} />}
      <InjectDialog />
      <WireTooltip edges={edgeMap} />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {card.hover && !s.hoverEdge && (() => {
        const n = s.graph?.nodes.find(x => x.id === card.hover!.id);
        return n && <NodeCard node={n} x={card.hover.x} y={card.hover.y} />;
      })()}
    </div>
  );
}

let lastReport: Extract<FromWebview, { type: 'rendered' }> | undefined;   // re-sent on 'probe'

export function App() {
  useEffect(() => {
    const st = useStore.getState;
    const onMsg = (ev: MessageEvent<ToWebview>) => {
      const m = ev.data;
      (window as { cfLast?: string }).cfLast = m.type;
      switch (m.type) {
        case 'init': void st().init(m.graph, m.layout, m.settings); break;
        case 'patch': void st().applyPatch(m.patch); break;
        case 'layout': void st().setLayout(m.layout); break;
        case 'settings': st().setSettings(m.settings, m.filters); break;
        case 'trace': st().applyTrace(m.events); break;
        case 'traceState': st().setTraceRunning(m.running); break;
        case 'status': st().setStatus(m.text, m.busy); break;
        case 'relayout': void st().relayout(); break;
        case 'followChain': useStore.setState(x => ({ chainRequest: { node: m.node, dir: m.dir, seq: (x.chainRequest?.seq ?? 0) + 1 } })); break;
        case 'source': st().setSource(m.id, m.text, m.start); break;
        case 'pause': st().addPause(m.pause); break;
        case 'resumed': st().dropPause(m.key); st().addLog({ kind: 'info', text: `pause ${m.key} ended: ${m.why}` }); break;
        case 'injected': st().addInjectResult(m.result); break;
        case 'traceError': st().addLog({ kind: 'error', text: m.message }); break;
        case 'probe': {
          const g = st().graph;
          const e = m.edge ? g?.edges.find(x => x.id === m.edge) : undefined;
          if (e) post({ type: 'rendered', visibleNodes: [], visibleEdges: [], tooltip: tooltipLines(e, st().edgeValues[e.id]) });
          else if (lastReport) post(lastReport);
          break;
        }
      }
    };
    window.addEventListener('message', onMsg);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
