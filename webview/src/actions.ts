// Canvas actions shared by context menus, wire clicks and keyboard shortcuts (UIX_RESEARCH.md 2.13 / 2.16).
import { useReactFlow } from '@xyflow/react';
import type { GraphEdge, GraphNode } from '../../shared/graph';
import { callChain, nodeRules, relPath, type ViewEdge } from './filters';
import { autoLayout, chainLayout, leafSize } from './layout';
import type { MenuEntry } from './panels/ContextMenu';
import { useStore } from './store';
import { post } from './vscode';

const st = useStore.getState;
const CALLABLE = new Set(['function', 'method', 'property', 'decorator', 'lambda']);

export function useActions(collapseAll: (collapsed: boolean) => void) {
  const rf = useReactFlow();

  /** Pan (keeping the zoom unless it is too small to read) to a node and select it. */
  const goTo = (id: string) => {
    const n = rf.getInternalNode(id);
    if (!n) return;
    const { x, y } = n.internals.positionAbsolute;
    const w = n.measured.width ?? 0, h = n.measured.height ?? 0;
    void rf.setCenter(x + w / 2, y + Math.min(h, 200) / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 400 });
    st().select(id);
  };

  /** Follow a wire to the callee end (or back to the caller with `back`). */
  const follow = (e: GraphEdge, back = false) => {
    // Depends wires are drawn provider -> consumer: "forward" means towards the provider being called
    const forward = e.kind === 'depends' ? e.source : e.target;
    const backward = e.kind === 'depends' ? e.target : e.source;
    goTo(back ? backward : forward);
  };

  /** Show only what `id` calls (forward) or what calls it (backward), packed and fitted (Canvas fits `fitTo`). */
  const followChain = (id: string, dir: 'forward' | 'backward') => {
    const g = st().graph;
    if (!g) return;
    st().select(id);
    st().setFocus({ node: id, chain: dir });
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    // the chain view has no frames: every member is placed on its own
    const shown = new Map([...callChain(g.edges, byId, id, dir)].filter(([n]) => !['class', 'module'].includes(byId.get(n)!.kind)));
    if (st().settings.pack !== 'off') {
      const flat = new Map([...shown.keys()].map(n => [n, { ...byId.get(n)!, parentId: null }]));
      st().arrange(chainLayout(shown, dir, flat, n => leafSize(byId.get(n)!, st().layout.nodes[n])));
    }
    useStore.setState({ fitTo: [...shown.keys()] });
  };

  /** Fit the view. With nodes hidden (filters, collapse), first pack the shown ones into a tight left-to-right flow. */
  const fit = async () => {
    const g = st().graph;
    const shown = rf.getNodes();
    const plain = (kind: string) => !['imports', 'globals', 'unresolved'].includes(kind);   // hubs come and go with their wires
    const hiddenSome = !!g && shown.filter(n => plain((n.data as { node: GraphNode }).node.kind)).length < g.nodes.filter(n => plain(n.kind)).length;
    if (!g || !hiddenSome || st().settings.pack === 'off' || !shown.length) {
      void rf.fitView({ padding: 0.1, duration: 300 });
      return;
    }
    const nodes = shown.map(n => (n.data as { node: GraphNode }).node);
    const ids = new Set(nodes.map(n => n.id));
    const edges = rf.getEdges().flatMap(e => (e.data as { view: ViewEdge }).view.edges)
      .filter(e => ids.has(e.source) && ids.has(e.target));
    st().arrange(await autoLayout(nodes, edges, st().firstSeen));
    useStore.setState({ fitTo: [...ids] });
  };

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  const nodeMenu = (n: GraphNode): MenuEntry[] => {
    const rules = nodeRules(n, st().graph?.root);
    const file = rules.file?.[0];
    const pkg = rules.pkg && rules.pkg.length > 1 ? rules.pkg[rules.pkg.length - 2] : rules.pkg?.[0];
    const hasChildren = !!st().graph?.nodes.some(c => c.parentId === n.id);
    const entries: MenuEntry[] = [
      { label: 'Open Source', icon: 'go-to-file', shortcut: 'Dbl-click', run: () => post({ type: 'openNode', id: n.id }), disabled: !n.file },
      { label: 'Inspect', icon: 'inspect', run: () => { st().select(n.id); st().setInspector(true); } },
      ...(CALLABLE.has(n.kind) ? [
        '-' as const,
        { label: st().layout.intercepts?.includes(n.id) ? 'Remove Intercept' : 'Intercept Here', icon: 'debug-breakpoint', shortcut: 'F9', run: () => st().toggleIntercept(n.id) },
        { label: 'Inject Call…', icon: 'zap', shortcut: 'Ctrl+Shift+Enter', run: () => { st().select(n.id); st().openInject(n.id); } },
      ] : []),
      '-',
      { label: 'Follow Forward (what it calls)', icon: 'arrow-circle-right', shortcut: 'Ctrl+→', run: () => followChain(n.id, 'forward') },
      { label: 'Follow Backward (what calls it)', icon: 'arrow-circle-left', shortcut: 'Ctrl+←', run: () => followChain(n.id, 'backward') },
      { label: "Show Only This Node's Wires", icon: 'filter', shortcut: 'W', run: () => { st().select(n.id); st().setFocus({ node: n.id, dir: 'all' }); } },
      { label: 'Show Only Inputs', icon: 'arrow-left', shortcut: 'Shift+W', run: () => { st().select(n.id); st().setFocus({ node: n.id, dir: 'in' }); } },
      { label: 'Show Only Outputs', icon: 'arrow-right', shortcut: 'Alt+W', run: () => { st().select(n.id); st().setFocus({ node: n.id, dir: 'out' }); } },
      { label: 'Show All Wires', icon: 'eye', run: () => st().setFocus(null), disabled: !st().focus },
      { label: 'Focus Neighbours', icon: 'target', shortcut: 'F', run: () => { st().select(n.id); st().setFilters({ neighboursOnly: !st().layout.filters.neighboursOnly }); } },
      '-',
    ];
    if (hasChildren) entries.push({ label: st().layout.nodes[n.id]?.collapsed ? 'Expand' : 'Collapse', icon: 'fold', shortcut: 'Space', run: () => st().toggleCollapse(n.id) }, '-');
    entries.push(
      { label: 'Hide Node', icon: 'eye-closed', shortcut: 'H', run: () => st().hideRule(`node:${n.id}`) },
      ...(file ? [{ label: `Hide File "${file.split('/').pop()}"`, icon: 'file', run: () => st().hideRule(file) }] : []),
      ...(pkg ? [{ label: `Hide Package "${pkg.slice(4)}"`, icon: 'package', run: () => st().hideRule(pkg) }] : []),
      '-',
      { label: 'Copy Qualified Name', icon: 'copy', run: () => copy(n.id) },
      ...(n.file ? [{ label: 'Copy file:line', icon: 'link', run: () => copy(`${relPath(n.file!, st().graph?.root)}:${n.range?.def ?? 1}`) }] : []),
    );
    return entries;
  };

  const edgeMenu = (v: ViewEdge): MenuEntry[] => {
    const e = v.edges[0];
    const locked = st().layout.lockedEdges.includes(e.id);
    return [
      { label: 'Follow to Callee', icon: 'arrow-right', shortcut: 'Click', run: () => follow(e) },
      { label: 'Follow to Caller', icon: 'arrow-left', shortcut: 'Alt+Click', run: () => follow(e, true) },
      { label: 'Inspect Wire', icon: 'inspect', run: () => st().selectEdge(e.id) },
      { label: 'Follow Forward from Callee', icon: 'arrow-circle-right', run: () => followChain(e.kind === 'depends' ? e.source : e.target, 'forward') },
      { label: 'Follow Backward from Caller', icon: 'arrow-circle-left', run: () => followChain(e.kind === 'depends' ? e.target : e.source, 'backward') },
      '-',
      { label: locked ? 'Unlock' : 'Lock Visible', icon: locked ? 'unlock' : 'lock', run: () => v.edges.forEach(x => st().toggleLock(x.id)) },
      { label: 'Show Both Ends Only', icon: 'split-horizontal', run: () => st().setFocus({ edge: e.id }) },
      '-',
      { label: `Hide Wire Kind "${e.kind.replace('_', ' ')}"`, icon: 'eye-closed', run: () => st().hideRule(`wire:${e.kind}`) },
      { label: `Hide Level ${e.level} Wires`, icon: 'eye-closed', run: () => {
        const f = st().layout.filters;
        st().setFilters({ inputLevels: f.inputLevels.filter(l => l !== e.level), outputLevels: f.outputLevels.filter(l => l !== e.level) });
      } },
    ];
  };

  const paneMenu = (): MenuEntry[] => [
    { label: 'Fit View', icon: 'screen-full', shortcut: '1', run: () => void fit() },
    { label: 'Zoom to Selection', icon: 'zoom-in', shortcut: '2', run: () => { const id = st().selected; if (id) goTo(id); }, disabled: !st().selected },
    { label: 'Reset Zoom (100%)', icon: 'zoom-out', shortcut: '0', run: () => void rf.zoomTo(1, { duration: 300 }) },
    '-',
    { label: 'Re-layout…', icon: 'layout', run: () => post({ type: 'command', name: 'relayout' }) },
    { label: 'Collapse All', icon: 'fold-up', run: () => collapseAll(true) },
    { label: 'Expand All', icon: 'fold-down', run: () => collapseAll(false) },
    '-',
    { label: st().settings.groupByFile ? 'Ungroup Files (flat flow)' : 'Group by File', icon: 'files', run: () => post({ type: 'setGroupByFile', value: !st().settings.groupByFile }) },
    { label: 'Show All Wires', icon: 'eye', run: () => st().setFocus(null), disabled: !st().focus },
  ];

  /** Keyboard shortcuts on the canvas (ignored while typing in an input). */
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return;
    const sel = st().selected;
    const k = ev.key.toLowerCase();
    if (k === 'escape') { st().setFocus(null); return; }
    if (k === 'f5' || k === 'f10') {
      ev.preventDefault();
      const intercept = st().pauses.find(p => p.reason === 'intercept');
      const step = st().pauses.find(p => p.reason === 'follow');
      if (k === 'f5' && intercept) st().answerPause(intercept.key, 'resume');
      else if (k === 'f5') st().setFollowHold(false);
      else if (step) st().answerPause(step.key, 'resume');
      return;
    }
    if (k === '1') void fit();
    else if (k === '0') void rf.zoomTo(1, { duration: 300 });
    else if (k === '2' && sel) goTo(sel);
    else if (!sel) return;
    else if ((k === 'arrowright' || k === 'arrowleft') && ev.ctrlKey) followChain(sel, k === 'arrowright' ? 'forward' : 'backward');
    else if (k === 'w') st().setFocus({ node: sel, dir: ev.shiftKey ? 'in' : ev.altKey ? 'out' : 'all' });
    else if (k === 'f') st().setFilters({ neighboursOnly: !st().layout.filters.neighboursOnly });
    else if (k === 'h') { st().hideRule(`node:${sel}`); st().select(null); }
    else if (k === ' ') { ev.preventDefault(); st().toggleCollapse(sel); }
    else if (k === 'enter' && ev.ctrlKey && ev.shiftKey) st().openInject(sel);
    else if (k === 'enter' && ev.ctrlKey) post({ type: 'openNode', id: sel });
    else if (k === 'f9') { ev.preventDefault(); st().toggleIntercept(sel); }
  };

  return { goTo, fit, follow, followChain, nodeMenu, edgeMenu, paneMenu, onKey };
}
