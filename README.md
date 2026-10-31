# Code Flow Canvas

Shows a Python codebase as a node canvas, like ComfyUI or n8n. Each box is a function or method. The wires are the calls, dependencies and globals that flow between them. The code is always the source of truth: the canvas is generated from it and updates when you save.

## Install

1. Download `code-flow-canvas-<version>.vsix` from the [latest release](https://github.com/HEchternacht/eex-ext/releases/latest).
2. Install it, either:
   - in VS Code: Extensions view → `···` menu → **Install from VSIX…** → pick the file, or
   - from a terminal: `code --install-extension code-flow-canvas-<version>.vsix`
3. Open a folder with Python code. Click the **Code Flow** icon in the activity bar, or run `Code Flow: Open Canvas` from the command palette.

The interpreter is, in order: the `codeflow.pythonPath` setting, the workspace's `.venv` / `venv` / `env`, then the Python extension's selection, then `py -3` / `python3`. Tracing runs your code in that interpreter, so it needs your project's dependencies (and pytest for **Trace tests**).

To try it on the bundled example (FastAPI + workers + SQLite):

```
git clone https://github.com/HEchternacht/eex-ext
cd eex-ext/sample
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
code .
```

### Build from source

```
npm install
npm run package
code --install-extension code-flow-canvas-<version>.vsix
```

## Use

- `Code Flow: Open Canvas` analyses the workspace and opens the canvas.
- Drag nodes anywhere. Positions, filters and locked wires are saved in `.vscode/codeflow.json`.
- Double-click a node to open only that function in a tab. Saving that tab writes the change back into the real file. Set `codeflow.editorMode` to `file` to open the real file with everything else folded instead.
- Hover a wire to see its type. Run `Code Flow: Trace Tests` (pytest) or `Code Flow: Trace Launch Config…` (a `debugpy` entry in launch.json) to light up nodes and wires as the code runs. After a run, hovering also shows the last value that passed through.
- `Code Flow: Attach Tracer…` attaches to a process that is already running. It needs Python 3.14 or later.
- **Filters** (toolbar) shows or hides nodes and wires by file, package, library, kind, wire type, flag or type. Right-click a node, wire or the background for the same actions plus focus, lock, copy and inspect.
- **Follow Forward / Follow Backward**: right-click a node or wire on the canvas, a function in the editor ("Follow Forward on Code Flow"), or a `.py` file in the Explorer (the whole file). The canvas shows only what it calls, transitively, or everything that calls it. The chain is packed tightly (callers left, callees right) and fitted. Ctrl+→ / Ctrl+← on a selected node; Esc or the chip's × brings everything back.
- **Fit** zooms to what is shown. When filters hide nodes, it first packs the shown ones together (left to right, callers to callees), and calls that pass through hidden nodes are drawn as dashed "via" wires. Hiding a file, class or package never hides the nodes inside it that are not filtered themselves.
- **Data-flow wires** (dash-dot, return → argument): when one function's return value reaches another function's argument, inside any caller, a wire joins them directly. Library calls in between are skipped and named on the wire (`via sorted, numpy.cumsum`), so with **no libs** the chain reads get_list → process → show. A hidden node passes its inputs through to its outputs the same way (`via process`). Hide them with the `flow` wire kind in the filter menu.
- **Inspector** (right panel): overview, last value (tree / table / JSON), type expanded down to builtins, callers, callees, source and call stats. **Log** (bottom): every traced call, return and error, filterable. By default it lists only nodes the canvas shows; the eye toggle shows hidden ones too.
- **Follow** (toolbar): the camera follows each call and the traced program waits until the animation catches up. Hold / Step (F10) / speed slider.
- **Intercept** (right-click a function, F9): the program pauses before that call. Edit the arguments (Python 3.13+), continue, or abort the call (raises `Aborted`). Skipping a call with a made-up return value is not possible from `sys.monitoring`, so it is not offered.
- **Inject** (right-click a function): call it with your own argument expressions, in the running program or in a fresh process.
- **Detach** (toolbar) moves the canvas into its own window, to maximise it or put it on another monitor.
- **Guide** (toolbar) explains everything on one page; the legend (bottom left) toggles filters when clicked.

## Wires

| Level | Input | Output |
|---|---|---|
| 1 | arguments | return value |
| 2 | functions called inside the body, `Depends(...)` | calls a function |
| 3 | class methods, globals, config | calls a method, writes a global |

- A call is one wire with arrows at both ends: arguments go in, the return value comes back.
- Library code is gathered into a single **Imports** node and module variables into a single **Globals** node.
- A link the analyser can't resolve with certainty is drawn dashed and goes to **Unresolved** (for example `getattr` dispatch or handler tables), or to its most likely targets (duck typing). Unresolved links are never hidden.

## Settings

Everything below is a `codeflow.*` setting.

| Setting | Default | |
|---|---|---|
| `pythonPath` | workspace .venv, then Python extension's interpreter | interpreter used for analysis and tracing |
| `exclude` | venvs, site-packages… | globs left out of the graph |
| `ignoreLibraryConnections` | false | hide every wire to third-party or stdlib code |
| `levelMode` | relative | `relative`: levels as seen from the selected node; `fixed`: one level per wire |
| `editorMode` | virtual | `virtual`: function-only tab; `file`: real file, folded |
| `nestSingleUse` | true | a function called from exactly one place is drawn inside its caller |
| `collapseThreshold` | 300 | above this many functions, classes and then modules start collapsed |
| `edgeThreshold` | 300 | above this many wires, wires appear only for the selected node (and locked wires) |
| `trace.maxValueLength` | 200 | traced values are cut to this many characters |
| `trace.history` | 1 | values kept per wire |
| `trace.flushMs` | 50 | how often the tracer sends events |
| `trace.glowMs` | 600 | length of the node glow / wire pulse |
| `trace.globals` | false | also trace writes to globals |
| `trace.persistValues` | false | keep the last values after a reload (stored in workspace state) |
| `trace.valueDepth` / `trace.valueItems` | 3 / 20 | how deep and how wide traced values are expanded |
| `groupByFile` | false | one area per file instead of one left-to-right flow (positions are kept per mode) |
| `colorScheme` | vscode | `vscode`, `n8n`, `comfy` or `high-contrast` |
| `showGuideOnStart` | true | open the guide the first time |
| `anim.maxBalls` | 30 | balls moving along wires at once |
| `log.maxEntries` | 5000 | log rows kept |
| `follow.stepMs` | 500 | time per step in follow mode |
| `follow.scope` | filtered | nodes that pause in follow mode: `filtered` (visible), `selected`, `all` |
| `follow.camera` | pan | `pan`, `panZoom` or `off` |
| `pack` | temporary | Fit (with nodes hidden) and Follow Forward/Backward pack the shown nodes: `temporary` (saved positions come back when filters change), `keep`, or `off` (zoom only) |
| `bridgeHidden` | true | a call or data flow through hidden nodes (A → hidden → C) is drawn as a dashed "via" wire A → C |
| `log.showHidden` | false | log also lists calls of nodes the canvas hides |
| `intercept.timeoutSec` | 300 | an unanswered intercept continues after this long (0: never) |

## Requirements

- The analyser runs on Python 3.9 or later; Jedi is bundled.
- Tracing uses `sys.monitoring` on Python 3.12 and later, and falls back to `sys.settrace` (slower) on older versions.

## Development

```
npm install
npm run build            # extension + webview
npm run test:unit        # vitest: filters, levels, collapse, tooltip
npm run test:py          # pytest: analyser + tracer against sample/ (needs sample/.venv, see Install)
npm run test:e2e         # VS Code acceptance tests against a copy of sample/
npm run package          # .vsix
```
