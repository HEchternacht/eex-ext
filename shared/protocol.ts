// Messages between the extension host and the canvas webview.
import type { Graph, GraphPatch } from './graph';
import type { LayoutState } from './layout';

export interface CanvasSettings {
  collapseThreshold: number;
  edgeThreshold: number;
  glowMs: number;
  levelMode: 'relative' | 'fixed';
  history: number;
  groupByFile: boolean;
  maxBalls: number;
  logMax: number;
  logShowHidden: boolean;
  bridgeHidden: boolean;
  colorScheme: 'vscode' | 'n8n' | 'comfy' | 'high-contrast';
  showGuide: boolean;            // open the guide on load (first open, codeflow.showGuideOnStart)
  followStepMs: number;
  followScope: 'all' | 'selected' | 'filtered';
  followCamera: 'pan' | 'panZoom' | 'off';
  pack: 'temporary' | 'keep' | 'off';
}

/** Structured traced value: type, kind, short repr, size, children (capped by trace.valueDepth / valueItems). */
export interface ValueTree {
  t: string;
  k: 'none' | 'bool' | 'int' | 'float' | 'complex' | 'str' | 'bytes' | 'list' | 'tuple' | 'set' | 'dict' | 'object'
    | 'dataclass' | 'pydantic' | 'enum' | 'callable' | 'coroutine' | 'exception' | 'cycle' | 'other';
  r: string;
  n?: number | null;
  items?: { key: string | number; v: ValueTree }[];
  more?: number;
}

export interface TracedValue { type: string; value: string; tree?: ValueTree }

/** One traced call or return, already mapped to graph ids by the extension. */
export interface TraceEvent {
  t: 'call' | 'return' | 'global';
  node: string;                 // callee node id
  caller?: string | null;       // nearest project caller (call/return)
  callers?: string[];           // project callers, nearest first (wrappers/decorators sit in between)
  count?: number;               // calls folded into this event by the tracer's batching
  args?: ({ name: string } & TracedValue)[];
  value?: TracedValue;          // return value / global value
  port?: string;                // global port
  ts: number;
}

/** The traced program is waiting at this step until the canvas answers (resume / abort). */
export interface PauseInfo {
  key: string;                  // `${conn}:${id}`: unique across traced processes
  reason: 'intercept' | 'follow';
  t: 'call' | 'return';
  node: string;
  callers: string[];
  args?: ({ name: string } & TracedValue)[];
  value?: TracedValue;
  editable: boolean;            // argument edits need Python 3.13+
  ts: number;
}

export interface InjectRequest {
  node: string;
  args: string[];               // Python expressions, evaluated in the function's module
  kwargs: Record<string, string>;
  self?: string;                // methods: expression for the instance
  target: 'auto' | 'fresh';     // auto: the running traced program if there is one
}

export interface InjectResult { id: number; node: string; ok: boolean; value?: TracedValue; error?: string; traceback?: string; where: 'live' | 'fresh' }

export interface TraceControl { intercept: string[]; follow: boolean; followNodes: string[] | null }

export type ToWebview =
  | { type: 'init'; graph: Graph; layout: LayoutState; settings: CanvasSettings }
  | { type: 'patch'; patch: GraphPatch }
  | { type: 'layout'; layout: LayoutState }             // import / reset
  | { type: 'settings'; settings: CanvasSettings; filters?: Partial<LayoutState['filters']> }
  | { type: 'trace'; events: TraceEvent[] }
  | { type: 'traceState'; running: boolean }
  | { type: 'status'; text: string; busy: boolean }
  | { type: 'relayout' }                                // place every node again
  | { type: 'followChain'; node: string; dir: 'forward' | 'backward' }   // editor / explorer context menu
  | { type: 'source'; id: string; text: string; start: number }   // inspector source preview
  | { type: 'pause'; pause: PauseInfo }
  | { type: 'resumed'; key: string; why: string }      // a pause ended without the canvas (timeout)
  | { type: 'injected'; result: InjectResult }
  | { type: 'traceError'; message: string }
  | { type: 'probe'; edge?: string };                   // tests: ask for a 'rendered' report (+ tooltip of an edge)

export type FromWebview =
  | { type: 'ready' }
  | { type: 'layout'; layout: LayoutState }
  | { type: 'openNode'; id: string }
  | { type: 'command'; name: 'reanalyse' | 'traceTests' | 'traceLaunch' | 'stopTrace' | 'relayout' | 'reload' | 'detach' }
  | { type: 'setGroupByFile'; value: boolean }
  | { type: 'source'; id: string }
  | { type: 'guideSeen' }
  | { type: 'error'; message: string }
  | { type: 'traceControl'; control: TraceControl }
  | { type: 'resume'; key: string; args?: Record<string, string> }
  | { type: 'abort'; key: string }
  | { type: 'inject'; request: InjectRequest }
  | { type: 'rendered'; visibleNodes: string[]; visibleEdges: string[];
      tooltip?: { label: string; type: string; value?: string }[] };
