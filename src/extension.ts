import * as path from 'path';
import * as vscode from 'vscode';
import { Graph, GraphPatch, applyPatch } from '../shared/graph';
import { LayoutState, emptyLayout } from '../shared/layout';
import type { FromWebview } from '../shared/protocol';
import { canvasSettings, cfg } from './config';
import { FunctionFileSystem, SCHEME } from './editor/fnFileSystem';
import { CanvasPanel } from './panel/CanvasPanel';
import { Sidecar, readLayout, writeLayout } from './persistence/sidecar';
import { AnalyzerClient } from './python/analyzerClient';
import { resolvePython } from './python/interpreter';
import { TraceSession } from './trace/session';

export class Controller implements vscode.Disposable {
  graph: Graph | undefined;
  layout: LayoutState = emptyLayout();
  readonly panel: CanvasPanel;
  readonly output = vscode.window.createOutputChannel('Code Flow');
  private analyzer: AnalyzerClient | undefined;
  private sidecar: Sidecar;
  private disposables: vscode.Disposable[] = [];
  private analyzing: Promise<Graph | undefined> | undefined;
  private updating = Promise.resolve();
  private _onPatched = new vscode.EventEmitter<GraphPatch>();
  readonly onPatched = this._onPatched.event;

  private _trace: TraceSession | undefined;

  constructor(readonly ctx: vscode.ExtensionContext, readonly root: vscode.Uri, private fs: FunctionFileSystem) {
    this.sidecar = new Sidecar(root);
    this.panel = new CanvasPanel(ctx.extensionUri, m => void this.onWebview(m), () => void this.sidecar.flush());
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.py'));
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.onSaved([uri])),
      watcher.onDidDelete(uri => this.onSaved([uri])),
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.onSaved([doc.uri]);
        if (doc.uri.scheme === 'file') this.fs.realFileChanged(doc.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration(e => this.onConfig(e)),
    );
  }

  log = (s: string) => this.output.append(s.endsWith('\n') ? s : s + '\n');

  private onConfig(e: vscode.ConfigurationChangeEvent) {
    if (!e.affectsConfiguration('codeflow')) return;
    if (['exclude', 'nestSingleUse', 'pythonPath'].some(k => e.affectsConfiguration(`codeflow.${k}`))) {
      this.analyzer?.dispose();
      this.analyzer = undefined;
      void this.analyze();
    }
    const c = cfg();
    this.panel.post({
      type: 'settings', settings: canvasSettings(this.guideSeen),
      filters: { ignoreLibraryConnections: c.ignoreLibraryConnections, wiresOnDemand: c.wiresOnDemand },
    });
  }

  get trace(): TraceSession {
    if (!this._trace) {
      const known = () => new Set(this.graph?.nodes.map(n => n.id));
      let ids = known();
      this.onPatched(() => (ids = known()));
      this._trace = new TraceSession({
        root: this.root,
        pyRoot: path.join(this.ctx.extensionPath, 'python'),
        python: () => resolvePython(this.root),
        knownNode: id => (ids.size ? ids : (ids = known())).has(id),
        post: events => this.panel.post({ type: 'trace', events }),
        send: msg => this.panel.post(msg),
        running: running => this.panel.post({ type: 'traceState', running }),
        log: this.log,
        state: this.ctx.workspaceState,
      });
    }
    return this._trace;
  }

  private async client(): Promise<AnalyzerClient> {
    if (!this.analyzer) {
      const python = await resolvePython(this.root);
      this.log(`python: ${python}`);
      this.analyzer = new AnalyzerClient(python, path.join(this.ctx.extensionPath, 'python'), this.log);
    }
    return this.analyzer;
  }

  async open() {
    if (this.panel.visible && this.graph) {
      this.panel.show();
      return;
    }
    this.panel.show();
    this.layout = await this.sidecar.load();
    if (!Object.keys(this.layout.nodes).length) {
      // first open: settings seed the filters; afterwards the saved filters win
      const c = cfg();
      this.layout.filters.ignoreLibraryConnections = c.ignoreLibraryConnections;
      this.layout.filters.wiresOnDemand = c.wiresOnDemand;
    }
    const graph = this.graph ?? (await this.analyze(false));
    if (graph) this.push(graph);
  }

  private push(graph: Graph) {
    this.panel.post({ type: 'init', graph, layout: this.layout, settings: canvasSettings(this.guideSeen) });
    const restored = this.trace.restoredValues();
    if (restored.length) this.panel.post({ type: 'trace', events: restored });
    this.panel.post({ type: 'traceState', running: this.trace.running });
  }

  /** Editor / explorer menu: show the call chain of the function under the cursor, or of a whole file. */
  async followChain(dir: 'forward' | 'backward', file: string, line?: number) {
    await this.open();
    const graph = this.graph;
    if (!graph) return;
    const same = (f: string | null) => !!f && path.normalize(f).toLowerCase() === path.normalize(file).toLowerCase();
    const inFile = graph.nodes.filter(n => same(n.file));
    // innermost function / class around the cursor, else the module itself
    const at = line === undefined ? [] : inFile
      .filter(n => n.kind !== 'module' && n.range && n.range.start <= line && line <= n.range.end)
      .sort((a, b) => (a.range!.end - a.range!.start) - (b.range!.end - b.range!.start));
    const node = at[0] ?? inFile.find(n => n.kind === 'module');
    if (!node) {
      void vscode.window.showInformationMessage(`Code Flow: ${path.basename(file)} is not in the graph.`);
      return;
    }
    this.panel.post({ type: 'followChain', node: node.id, dir });
  }

  /** Move the canvas into its own window (maximise it, put it on another monitor). */
  async detach() {
    await this.open();
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  async analyze(push = true): Promise<Graph | undefined> {
    if (this.analyzing) return this.analyzing;
    this.analyzing = (async () => {
      this.panel.post({ type: 'status', text: 'Analysing…', busy: true });
      try {
        const c = cfg();
        const graph = await (await this.client()).analyze(this.root.fsPath, c.exclude, c.nestSingleUse);
        this.graph = graph;
        Object.entries(graph.errors).forEach(([f, e]) => this.log(`parse error ${f}: ${e}`));
        this.panel.post({ type: 'status', text: `${graph.nodes.length} nodes · ${graph.edges.length} wires`, busy: false });
        if (push) this.panel.post({ type: 'init', graph, layout: this.layout, settings: canvasSettings(this.guideSeen) });
        return graph;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(msg);
        this.panel.post({ type: 'status', text: `Analysis failed: ${msg}`, busy: false });
        void vscode.window.showErrorMessage(`Code Flow: ${msg}`);
        return undefined;
      } finally {
        this.analyzing = undefined;
      }
    })();
    return this.analyzing;
  }

  onSaved(uris: vscode.Uri[]) {
    const files = uris.filter(u => u.scheme === 'file' && u.fsPath.endsWith('.py') && u.fsPath.startsWith(this.root.fsPath));
    if (!files.length || !this.graph) return;
    this.updating = this.updating.then(async () => {
      try {
        const patch = await (await this.client()).update(files.map(f => f.fsPath));
        if (!this.graph) return;
        this.graph = applyPatch(this.graph, patch);
        this.panel.post({ type: 'patch', patch });
        this._onPatched.fire(patch);
      } catch (e) {
        this.log(String(e));
      }
    });
  }

  private async onWebview(m: FromWebview) {
    switch (m.type) {
      case 'ready':   // a reload (e.g. moved to another window) starts the webview empty
        if (this.panel.readyCount > 1 && this.graph) this.push(this.graph);
        break;
      case 'layout':
        this.layout = m.layout;
        this.sidecar.save(m.layout);
        break;
      case 'openNode':
        await vscode.commands.executeCommand('codeflow.openNode', m.id);
        break;
      case 'command':
        await vscode.commands.executeCommand(`codeflow.${m.name}`);
        break;
      case 'source': {
        const n = this.graph?.nodes.find(x => x.id === m.id);
        if (!n?.file || !n.range) break;
        const lines = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(n.file))).toString('utf8').split(/\r?\n/);
        this.panel.post({ type: 'source', id: n.id, text: lines.slice(n.range.start - 1, n.range.end).join('\n'), start: n.range.start });
        break;
      }
      case 'error':
        this.webviewErrors.push(m.message);
        this.log(`webview: ${m.message}`);
        break;
      case 'traceControl':
        this.trace.setControl(m.control);
        break;
      case 'resume':
        this.trace.resume(m.key, m.args);
        break;
      case 'abort':
        this.trace.abort(m.key);
        break;
      case 'inject':
        await this.trace.inject(m.request);
        break;
      case 'guideSeen':
        await this.ctx.globalState.update('codeflow.guideSeen', true);
        break;
      case 'setGroupByFile':
        await vscode.workspace.getConfiguration('codeflow').update('groupByFile', m.value, vscode.ConfigurationTarget.Workspace);
        break;
    }
  }

  async exportLayout() {
    await this.sidecar.flush();
    const uri = await vscode.window.showSaveDialog({
      filters: { JSON: ['json'] }, defaultUri: vscode.Uri.joinPath(this.root, 'codeflow-layout.json'),
    });
    if (uri) await writeLayout(uri, this.layout);
  }

  async importLayout() {
    const [uri] = (await vscode.window.showOpenDialog({ filters: { JSON: ['json'] } })) ?? [];
    if (!uri) return;
    this.layout = await readLayout(uri);
    this.sidecar.save(this.layout);
    this.panel.post({ type: 'layout', layout: this.layout });
  }

  async resetLayout() {
    this.layout = { ...emptyLayout(), filters: this.layout.filters };
    this.sidecar.save(this.layout);
    this.panel.post({ type: 'layout', layout: this.layout });
  }

  readonly webviewErrors: string[] = [];   // also read by tests

  /** Close and reopen the canvas (after a webview error). */
  async reload() {
    this.panel.dispose();
    await this.open();
  }

  get guideSeen() {
    return this.ctx.globalState.get<boolean>('codeflow.guideSeen', false);
  }

  async relayout() {
    const ok = await vscode.window.showWarningMessage('Code Flow: place every node again? Your saved positions are replaced.', { modal: true }, 'Re-layout');
    if (ok) this.panel.post({ type: 'relayout' });
  }

  flush() {
    return this.sidecar.flush();
  }

  async locate(source: string, qualname: string) {
    return (await this.client()).locate(source, qualname);
  }

  dispose() {
    this._trace?.dispose();
    void this.sidecar.flush();
    this.analyzer?.dispose();
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.output.dispose();
  }
}

let controller: Controller | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  // registered up front so codeflow: tabs restored with the window can load
  const fs = new FunctionFileSystem((source, qualname) => need().locate(source, qualname));
  ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }));
  const need = (): Controller => {
    if (!controller) {
      if (!root) throw new Error('Open a folder first.');
      controller = new Controller(ctx, root, fs);
      ctx.subscriptions.push(controller);
    }
    return controller;
  };
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
      try {
        return await fn(...a);
      } catch (e) {
        void vscode.window.showErrorMessage(`Code Flow: ${e instanceof Error ? e.message : e}`);
      }
    }));

  reg('codeflow.open', () => need().open());
  reg('codeflow.reanalyse', () => need().analyze());
  reg('codeflow.exportLayout', () => need().exportLayout());
  reg('codeflow.importLayout', () => need().importLayout());
  reg('codeflow.resetLayout', () => need().resetLayout());
  reg('codeflow.relayout', () => need().relayout());
  reg('codeflow.reload', () => need().reload());
  reg('codeflow.detach', () => need().detach());
  // activity bar icon: an empty view (its welcome text holds the actions) that opens the canvas when shown
  const home = vscode.window.createTreeView('codeflow.home', { treeDataProvider: { getChildren: () => [], getTreeItem: (x: vscode.TreeItem) => x } });
  ctx.subscriptions.push(home, home.onDidChangeVisibility(e => { if (e.visible && root) void need().open(); }));
  const atCursor = (dir: 'forward' | 'backward') => () => {
    const ed = vscode.window.activeTextEditor;
    if (ed) return need().followChain(dir, ed.document.uri.fsPath, ed.selection.active.line + 1);
  };
  reg('codeflow.followForward', atCursor('forward'));
  reg('codeflow.followBackward', atCursor('backward'));
  reg('codeflow.followForwardFile', (uri: vscode.Uri) => need().followChain('forward', uri.fsPath));
  reg('codeflow.followBackwardFile', (uri: vscode.Uri) => need().followChain('backward', uri.fsPath));
  reg('codeflow.openNode', (id: string) => openNode(need(), id));
  reg('codeflow.traceTests', async () => { await need().open(); return need().trace.traceTests(); });
  reg('codeflow.traceLaunch', async (name?: string) => { await need().open(); return need().trace.traceLaunch(name); });
  reg('codeflow.attach', async (pid?: number) => { await need().open(); return need().trace.attach(pid); });
  reg('codeflow.stopTrace', () => need().trace.stop());

  // test / automation hook
  return { get controller() { return controller; }, need };
}

/** Double-click on a node: a tab with only that function (virtual) or the real file folded around it. */
export async function openNode(c: Controller, id: string): Promise<vscode.TextEditor | undefined> {
  const n = c.graph?.nodes.find(x => x.id === id);
  if (!n?.file || !n.range) return;
  const sliceable = ['function', 'method', 'property', 'decorator', 'class'].includes(n.kind);
  if (cfg().editorMode === 'virtual' && sliceable) {
    const doc = await vscode.workspace.openTextDocument(FunctionFileSystem.uriFor(n.file, n.qualname));
    return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }
  const doc = await vscode.workspace.openTextDocument(n.file);
  const end = Math.min(n.range.end, doc.lineCount) - 1;
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(n.range.start - 1, 0, end, doc.lineAt(end).text.length),
  });
  if (n.kind !== 'module') await vscode.commands.executeCommand('editor.foldAllExcept');
  return editor;
}

export function deactivate() {
  return controller?.flush();
}
