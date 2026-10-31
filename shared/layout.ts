// Persisted per-workspace state: .vscode/codeflow.json. Same schema is used by Export/Import Layout.

export type GroupMode = 'flat' | 'file';

export interface NodeLayout { x: number; y: number; w?: number; h?: number; collapsed?: boolean; openGroups?: string[] }

export interface Filters {
  inputLevels: number[];     // subset of [1,2,3]
  outputLevels: number[];
  ignoreLibraryConnections: boolean;
  neighboursOnly: boolean;
  pathFilter: string;        // substring / glob on file path, '' = all
  wiresOnDemand: boolean;
  hidden: string[];          // filter-menu rules: 'file:app/x.py' 'file:app/' 'pkg:app.core' 'lib:asyncio' 'kind:lambda'
                             // 'wire:depends' 'flag:unresolved|resolved|project|library' 'type:str' 'node:<id>'
  solo: string[];            // same rule syntax: per category, only what matches one of its solo rules is shown
}

export interface LayoutState {
  version: 1;
  nodes: Record<string, NodeLayout>;
  nodesMode?: GroupMode;                       // grouping `nodes` belongs to (missing = 'file', v0.1 layouts)
  otherNodes?: Record<string, NodeLayout>;     // positions of the other grouping mode
  filters: Filters;
  lockedEdges: string[];
  intercepts?: string[];     // node ids where the traced program pauses
  viewport: { x: number; y: number; zoom: number } | null;
}

export const DEFAULT_FILTERS: Filters = {
  inputLevels: [1, 2, 3],
  outputLevels: [1, 2, 3],
  ignoreLibraryConnections: false,
  neighboursOnly: false,
  pathFilter: '',
  wiresOnDemand: false,
  hidden: [],
  solo: [],
};

export function emptyLayout(): LayoutState {
  return { version: 1, nodes: {}, filters: { ...DEFAULT_FILTERS }, lockedEdges: [], viewport: null };
}

/** `layout` with `nodes` holding the positions of `mode` (the two position sets are swapped if needed). */
export function withMode(layout: LayoutState, mode: GroupMode): LayoutState {
  if ((layout.nodesMode ?? 'file') === mode) return layout;
  return { ...layout, nodesMode: mode, nodes: layout.otherNodes ?? {}, otherNodes: layout.nodes };
}

export function normalizeLayout(raw: unknown): LayoutState {
  const base = emptyLayout();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<LayoutState>;
  return {
    version: 1,
    nodes: r.nodes && typeof r.nodes === 'object' ? r.nodes : {},
    nodesMode: r.nodesMode === 'flat' ? 'flat' : 'file',
    otherNodes: r.otherNodes && typeof r.otherNodes === 'object' ? r.otherNodes : {},
    filters: { ...base.filters, ...(r.filters ?? {}) },
    lockedEdges: Array.isArray(r.lockedEdges) ? r.lockedEdges : [],
    intercepts: Array.isArray(r.intercepts) ? r.intercepts : [],
    viewport: r.viewport ?? null,
  };
}
