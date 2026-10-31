// Graph model shared by the extension host and the webview. Mirrors python/codeflow_py/analyze/graph.py.

export type NodeKind =
  | 'module' | 'class' | 'function' | 'method' | 'lambda' | 'property' | 'decorator'
  | 'imports' | 'globals' | 'unresolved';

export type EdgeKind =
  | 'call' | 'method_call' | 'reference' | 'decorates' | 'depends' | 'global_read' | 'global_write'
  | 'flow';   // a producer's return value reaches a parameter (library calls in between are bypassed)

export type Level = 1 | 2 | 3;

export interface Port {
  id: string;            // 'in' | 'calls' | 'return' | 'arg:<name>' | <symbol> on special nodes
  name: string;
  dir: 'in' | 'out' | 'inout';
  role: 'call' | 'arg' | 'return' | 'calls' | 'symbol';
  type: string | null;
  default?: string;      // arg ports: source text of the default value
}

export interface GraphNode {
  id: string;            // module.qualname, or '<imports>' | '<globals>' | '<unresolved>'
  kind: NodeKind;
  label: string;
  module: string | null;
  qualname: string;
  parentId: string | null;
  nestedIn?: string;     // set when nested by the single-call-site rule
  abstract?: boolean;
  file: string | null;
  range: { start: number; end: number; def: number } | null;
  isAsync: boolean;
  ports: Port[];
  doc?: string;
  signature?: string;    // 'async def f(a: int, b=2) -> str' / 'class C(Base)' / 'lambda x'
  decorators?: string[]; // source text without '@'
  bases?: string[];      // classes
  fields?: ClassField[]; // classes: annotated / class-level names and self.x set in __init__
}

export interface ClassField { name: string; type: string | null; default?: string; line: number }

export interface CallArg { expr: string; type: string | null }

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  level: Level;          // caller's view
  external: boolean;
  resolved: boolean;
  typeIn: string | null;
  typeOut: string | null;
  label: string | null;
  args: CallArg[];
  sites: { file: string; line: number }[];
}

export interface Graph {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: Record<string, string>;
}

export interface GraphPatch {
  removedNodes: string[];
  upsertNodes: GraphNode[];
  removedEdges: string[];
  upsertEdges: GraphEdge[];
  errors: Record<string, string>;
}

export const SPECIAL_NODES = ['<imports>', '<globals>', '<unresolved>'];

export function applyPatch(g: Graph, p: GraphPatch): Graph {
  const nodes = new Map(g.nodes.map(n => [n.id, n]));
  const edges = new Map(g.edges.map(e => [e.id, e]));
  p.removedNodes.forEach(id => nodes.delete(id));
  p.upsertNodes.forEach(n => nodes.set(n.id, n));
  p.removedEdges.forEach(id => edges.delete(id));
  p.upsertEdges.forEach(e => edges.set(e.id, e));
  return { root: g.root, nodes: [...nodes.values()], edges: [...edges.values()], errors: p.errors };
}
