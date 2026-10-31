// Acceptance criteria from REQUEST.md §10, run against a temp copy of sample/.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../../../src/extension';
import type { LayoutState } from '../../../shared/layout';

const WS = process.env.CODEFLOW_TEST_WORKSPACE!;

async function waitFor<T>(fn: () => T | undefined | false, ms = 60000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function controller(): Promise<Controller> {
  const ext = vscode.extensions.getExtension('local.code-flow-canvas')!;
  const api = await ext.activate();
  return api.need();
}

/** Push a layout into the webview and wait until it reports a render that satisfies `check`. */
async function render(c: Controller, mutate: (l: LayoutState) => LayoutState, check: (edges: string[], nodes: string[]) => boolean) {
  c.panel.post({ type: 'layout', layout: mutate(structuredClone(c.layout)) });
  return waitFor(() => {
    const r = c.panel.lastRendered;
    return r && check(r.visibleEdges, r.visibleNodes) && r;
  }, 20000, 'render');
}

/** Close the tabs showing `uri` (closeActiveEditor may hit the canvas when focus moved). */
async function closeDoc(uri: vscode.Uri) {
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
    .filter(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  await vscode.window.tabGroups.close(tabs);
}

suite('Acceptance', () => {
  let c: Controller;

  suiteSetup(async () => {
    await vscode.workspace.getConfiguration('codeflow').update('pythonPath', process.env.CODEFLOW_TEST_PYTHON, vscode.ConfigurationTarget.Global);
    // show every wire (the sample is above the default wires-on-demand threshold)
    await vscode.workspace.getConfiguration('codeflow').update('edgeThreshold', 100000, vscode.ConfigurationTarget.Global);
    c = await controller();
    await vscode.commands.executeCommand('codeflow.open');
    await waitFor(() => c.panel.lastRendered?.visibleNodes.includes('app.main.create_app'), 90000, 'first render')
      .catch(e => { throw new Error(`${e.message}; webview errors: ${c.webviewErrors.join(' | ')}; rendered: ${c.panel.lastRendered?.visibleNodes.length}`); });
  });

  test('1. FastAPI project shows app with routers and endpoints wired', () => {
    const r = c.panel.lastRendered!;
    for (const id of ['app.main.create_app', 'app.routers', 'app.routers.items.list_items', 'app.routers.jobs.submit_job', '<globals>']) {
      assert.ok(r.visibleNodes.includes(id), `node ${id} visible`);
    }
    const e = new Set(r.visibleEdges);
    assert.ok(e.has('global_read|<globals>|app.routers.api_router|app.main.create_app|in'), 'create_app reads api_router');
    assert.ok(e.has('global_write|app.routers|calls|<globals>|app.routers.api_router'), 'routers package builds api_router');
    assert.ok(e.has('global_read|<globals>|app.routers.items.router|app.routers|in'), 'api_router includes items.router');
    assert.ok(e.has('global_read|<globals>|app.routers.items.router|app.routers.items.list_items|in'), 'items router feeds endpoint');
    assert.ok([...e].some(id => id.startsWith('depends|app.dependencies.get_item_service|')), 'Depends wires drawn');
  });

  test('2. level and ignore_library_connections filters change visible wires immediately', async () => {
    const graph = c.graph!;
    const byId = new Map(graph.edges.map(e => [e.id, e]));
    const all = c.panel.lastRendered!.visibleEdges;
    assert.ok(all.some(id => byId.get(id)?.external), 'library wires visible by default');

    const t0 = Date.now();
    let r = await render(c, l => ({ ...l, filters: { ...l.filters, ignoreLibraryConnections: true } }),
      edges => !edges.some(id => byId.get(id)?.external));
    assert.ok(!r.visibleNodes.includes('<imports>'));
    assert.ok(Date.now() - t0 < 5000, 'applied quickly');
    assert.ok(r.visibleEdges.includes('flow|app.config.get_settings|return|app.core.master.Master.__init__|arg:worker_count'),
      'data-flow wires (library calls bypassed) stay without libraries');

    r = await render(c, l => ({ ...l, filters: { ...l.filters, ignoreLibraryConnections: false, outputLevels: [3] } }),
      edges => edges.length > 0 && edges.every(id => byId.get(id)?.level === 3));
    assert.ok(r.visibleEdges.length < all.length);

    r = await render(c, l => ({ ...l, filters: { ...l.filters, outputLevels: [1, 2, 3] } }), edges => edges.length === all.length);

    // the VS Code setting drives the same filter
    await vscode.workspace.getConfiguration('codeflow').update('ignoreLibraryConnections', true, vscode.ConfigurationTarget.Global);
    await waitFor(() => c.panel.lastRendered && !c.panel.lastRendered.visibleEdges.some(id => byId.get(id)?.external), 20000, 'setting applied');
    await vscode.workspace.getConfiguration('codeflow').update('ignoreLibraryConnections', false, vscode.ConfigurationTarget.Global);
    await waitFor(() => c.panel.lastRendered?.visibleEdges.some(id => byId.get(id)?.external), 20000, 'setting reverted');
  });

  test('3. wire hover shows the type; after a traced run also the last value', async () => {
    const edgeId = c.graph!.edges.find(e => e.source === 'app.core.master.Master.submit'
      && e.target === 'app.db.repository.JobRepository.create')!.id;
    const tooltip = async () => {
      const next = c.panel.nextRendered();
      c.panel.post({ type: 'probe', edge: edgeId });
      return (await next).tooltip!;
    };
    let lines = await tooltip();
    const out = lines.find(l => l.label === 'out')!;
    assert.strictEqual(out.type, 'JobOut');
    assert.strictEqual(out.value, undefined);
    assert.ok(lines.some(l => l.label.startsWith('in ') && l.type === 'JobCreate'));

    await vscode.commands.executeCommand('codeflow.traceTests');
    await waitFor(() => c.trace.received.some(e => e.t === 'return' && e.node === 'app.db.repository.JobRepository.create'),
      120000, 'traced return value');
    await waitFor(() => !c.trace.running, 120000, 'trace finished');
    lines = await tooltip();
    const traced = lines.find(l => l.label === 'out')!;
    assert.strictEqual(traced.type, 'JobOut');
    assert.match(traced.value ?? '', /^JobOut\(id=\d+/);
    assert.ok(lines.some(l => l.label.startsWith('in ') && l.value), 'argument values too');
    // nodes fired: the square handler got a value even though it runs in a worker thread
    assert.ok(c.trace.received.some(e => e.node === 'app.core.workers._square' && e.t === 'return'));
  });

  test('4. double-click opens only that function; saving updates the file and the graph', async () => {
    const id = 'app.services.pricing.compute_total';
    const file = c.graph!.nodes.find(n => n.id === id)!.file!;
    const before = fs.readFileSync(file, 'utf8');
    const editor = (await vscode.commands.executeCommand('codeflow.openNode', id)) as vscode.TextEditor;
    assert.strictEqual(editor.document.uri.scheme, 'codeflow');
    assert.strictEqual(editor.document.languageId, 'python');
    const text = editor.document.getText();
    assert.match(text, /^def compute_total\(/);
    assert.ok(!text.includes('def tax_rate'), 'only this function');

    const patched = new Promise(resolve => c.onPatched(p => p.upsertNodes.some(n => n.id === id) && resolve(p)));
    const firstLine = editor.document.lineAt(0);
    await editor.edit(b => b.replace(firstLine.range, firstLine.text.replace(') ->', ', extra_fee: float = 0.0) ->')));
    assert.ok(await editor.document.save(), 'virtual doc saved');

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes(', extra_fee: float = 0.0) ->'));
    assert.strictEqual(after.split('\n').length, before.split('\n').length, 'rest of file untouched');
    assert.strictEqual(after.replace(', extra_fee: float = 0.0', ''), before);
    await Promise.race([patched, new Promise((_, rej) => setTimeout(() => rej(new Error('no graph patch')), 60000))]);
    const node = c.graph!.nodes.find(n => n.id === id)!;
    assert.ok(node.ports.some(p => p.id === 'arg:extra_fee' && p.type === 'float'), 'graph updated');
    await closeDoc(editor.document.uri);

    // file mode: real file, function selected
    await vscode.workspace.getConfiguration('codeflow').update('editorMode', 'file', vscode.ConfigurationTarget.Global);
    const real = (await vscode.commands.executeCommand('codeflow.openNode', id)) as vscode.TextEditor;
    assert.strictEqual(real.document.uri.fsPath.toLowerCase(), file.toLowerCase());
    assert.strictEqual(real.selection.start.line, node.range!.start - 1);
    await vscode.workspace.getConfiguration('codeflow').update('editorMode', undefined, vscode.ConfigurationTarget.Global);
    await closeDoc(real.document.uri);
    assert.ok(c.panel.visible, 'canvas still open');
  });

  test('5. reopening restores node positions and filters', async () => {
    const id = 'app.main.create_app';
    const before = `before: mode=${c.layout.nodesMode} x=${c.layout.nodes[id]?.x}`;
    await render(c, l => ({
      ...l,
      nodes: { ...l.nodes, [id]: { ...l.nodes[id], x: 1234, y: 567 } },
      filters: { ...l.filters, inputLevels: [1, 3] },
    }), () => true);
    await waitFor(() => c.layout.nodes[id]?.x === 1234 && c.layout.filters.inputLevels.join() === '1,3', 10000,
      'layout echoed').catch(e => { throw new Error(`${e.message}: ${JSON.stringify(c.layout.nodes[id])} ${JSON.stringify(c.layout.filters)} mode=${c.layout.nodesMode} other=${JSON.stringify(c.layout.otherNodes?.[id])} n=${Object.keys(c.layout.nodes).length} ${before} readyCount=${c.panel.readyCount} webview errors: ${c.webviewErrors.join(' | ')}`); });
    await c.flush();
    const file = path.join(WS, '.vscode', 'codeflow.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutState;
    assert.strictEqual(saved.nodes[id].x, 1234);

    c.panel.dispose();
    c.layout = { ...c.layout, nodes: {} };       // forget in-memory state: must come back from disk
    c.panel.lastRendered = undefined;
    await vscode.commands.executeCommand('codeflow.open');
    await waitFor(() => c.panel.lastRendered, 60000, 'render after reopen');
    assert.strictEqual(c.layout.nodes[id].x, 1234);
    assert.strictEqual(c.layout.nodes[id].y, 567);
    assert.deepStrictEqual(c.layout.filters.inputLevels, [1, 3]);
    // webview kept them too (it echoes its layout back when it re-persists)
    const otherSaved = Object.keys(saved.nodes).length;
    assert.strictEqual(Object.keys(c.layout.nodes).length, otherSaved);
  });

  test('6. intercept pauses Master.submit; an edited argument reaches the program', async () => {
    const node = 'app.core.master.Master.submit';
    const from = c.trace.pausesSeen.length;
    // the product path: intercepts live in the layout, so a webview reload keeps them
    await render(c, l => ({ ...l, intercepts: [node] }), () => true);
    await waitFor(() => c.layout.intercepts?.includes(node), 10000, 'intercept saved');
    // answer every pause: the first one with an edit, the rest unchanged
    const answered = new Set<string>();
    const responder = setInterval(() => {
      for (const p of c.trace.pausesSeen.slice(from)) {
        if (answered.has(p.key)) continue;
        answered.add(p.key);
        c.trace.resume(p.key, answered.size === 1 ? { job: "job.model_copy(update={'priority': 1})" } : undefined);
      }
    }, 50);
    try {
      await vscode.commands.executeCommand('codeflow.traceTests');
      const first = await waitFor(() => c.trace.pausesSeen.slice(from).find(p => p.node === node), 60000, 'intercept pause')
        .catch(e => { throw new Error(`${e.message}: pauses=${c.trace.pausesSeen.length - from} running=${c.trace.running} received=${c.trace.received.length} readyCount=${c.panel.readyCount} webview errors: ${c.webviewErrors.join(' | ')}`); });
      assert.strictEqual(first.reason, 'intercept');
      assert.ok(first.args?.some(a => a.name === 'job' && /priority=/.test(a.value)), 'arguments shown at the pause');
      await waitFor(() => c.trace.received.some(e => e.t === 'return' && e.node === node && /priority=1\b/.test(e.value?.value ?? '')),
        120000, 'edited priority in the return value');
      await waitFor(() => !c.trace.running, 120000, 'trace finished');
    } finally {
      clearInterval(responder);
      await render(c, l => ({ ...l, intercepts: [] }), () => true);
      await waitFor(() => !c.layout.intercepts?.length, 10000, 'intercept cleared');
    }
  });

  test('7. inject compute_total(10, 2) in a fresh process returns its value', async () => {
    const from = c.trace.injectedSeen.length;
    await c.trace.inject({ node: 'app.services.pricing.compute_total', args: [], kwargs: { price: '10', quantity: '2' }, target: 'fresh' });
    const r = await waitFor(() => c.trace.injectedSeen[from], 120000, 'inject result');
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.where, 'fresh');
    assert.match(r.value!.value, /^\d+(\.\d+)?$/);
    assert.ok(c.trace.received.some(e => e.node === 'app.services.pricing.tax_rate'), 'the pipeline under it was traced');
    await waitFor(() => !c.trace.running, 60000, 'inject process finished');
  });

  test('8. follow mode: the program advances only after the canvas animates each step', async () => {
    const node = 'app.services.pricing.compute_total';
    const step = 500;   // codeflow.follow.stepMs default
    const pausesFrom = c.trace.pausesSeen.length;
    const from = c.trace.injectedSeen.length;
    c.trace.setControl({ intercept: [], follow: true, followNodes: [node] });
    try {
      const t0 = Date.now();
      await c.trace.inject({ node, args: [], kwargs: { price: '3', quantity: '1' }, target: 'fresh' });
      const r = await waitFor(() => c.trace.injectedSeen[from], 120000, 'inject result under follow');
      assert.ok(r.ok, r.error);
      const steps = c.trace.pausesSeen.slice(pausesFrom).filter(p => p.node === node);
      assert.deepStrictEqual(steps.map(p => `${p.reason}:${p.t}`), ['follow:call', 'follow:return']);
      // the webview's driver acknowledged each step only after its animation
      assert.ok(steps[1].at - steps[0].at >= step * 0.9, `return came ${steps[1].at - steps[0].at} ms after the call step`);
      assert.ok(Date.now() - t0 >= step * 2 * 0.9);
    } finally {
      c.trace.setControl({ intercept: [], follow: false, followNodes: null });
      await waitFor(() => !c.trace.running, 60000, 'inject process finished');
    }
  });

  test('8a. without launch.json, Trace Launch offers the detected app; picking it saves the config and traces it', async () => {
    const before = c.trace.received.length;
    try {
      await vscode.commands.executeCommand('codeflow.traceLaunch', 'app.main:app (uvicorn)');
      const saved = vscode.workspace.getConfiguration('launch').get<any[]>('configurations') ?? [];
      assert.ok(saved.some(s => s.module === 'uvicorn' && s.args?.[0] === 'app.main:app'), JSON.stringify(saved));
      // the app's startup (create_app, lifespan) runs under the tracer
      await waitFor(() => c.trace.received.slice(before).some(e => e.node === 'app.main.create_app'), 60000, 'create_app traced');
    } finally {
      await vscode.commands.executeCommand('codeflow.stopTrace');
      await waitFor(() => !c.trace.running, 30000, 'uvicorn stopped');
      await waitFor(() => !(c.trace as any).server?.connections, 30000, 'uvicorn tracer disconnected');
    }
  });

  test('8b. inject into a running program (launch config); Stop Trace ends it', async () => {
    fs.writeFileSync(path.join(WS, 'loop.py'), 'import time\n\nwhile True:\n    time.sleep(0.1)\n');
    fs.mkdirSync(path.join(WS, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.vscode', 'launch.json'), JSON.stringify({
      version: '0.2.0', configurations: [{ name: 'loop', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/loop.py' }],
    }));
    await waitFor(() => vscode.workspace.getConfiguration('launch').get<any[]>('configurations')?.some(x => x.name === 'loop'), 20000, 'launch.json read');
    const from = c.trace.injectedSeen.length;
    try {
      await vscode.commands.executeCommand('codeflow.traceLaunch', 'loop');
      await waitFor(() => (c.trace as any).server?.connections, 60000, 'tracer connected');
      await c.trace.inject({ node: 'app.services.pricing.compute_total', args: [], kwargs: { price: '10', quantity: '2' }, target: 'auto' });
      const r = await waitFor(() => c.trace.injectedSeen[from], 60000, 'live inject result');
      assert.ok(r.ok, r.error);
      assert.strictEqual(r.where, 'live');
      assert.match(r.value!.value, /^\d+(\.\d+)?$/);
    } finally {
      await vscode.commands.executeCommand('codeflow.stopTrace');
      await waitFor(() => !c.trace.running, 30000, 'loop stopped');
    }
  });

  test('9. hiding a folder keeps its subfolders; calls through hidden nodes get via wires', async () => {
    const r = await render(c, l => ({ ...l, filters: { ...l.filters, hidden: ['file:app/', 'file:app/db/'] } }),
      (_, nodes) => !nodes.includes('app.main.create_app'));
    assert.ok(r.visibleNodes.includes('app.core.master.Master.submit'), `app/core still shown with app/ hidden: ${r.visibleNodes.length} ${r.visibleNodes.filter(n => n.includes('core')).slice(0, 8)}`);
    assert.ok(!r.visibleNodes.includes('app.main.create_app'), 'app/main.py hidden');
    assert.ok(r.visibleEdges.some(e => e.startsWith('via|')), 'a call through app/db is bridged');
    await render(c, l => ({ ...l, filters: { ...l.filters, hidden: [] } }), (_, nodes) => nodes.includes('app.main.create_app'));
  });

  test('10. editor menu "Follow Backward on Code Flow" shows only the callers of the function at the cursor', async () => {
    const id = 'app.services.pricing.compute_total';
    const n = c.graph!.nodes.find(x => x.id === id)!;
    const doc = await vscode.workspace.openTextDocument(n.file!);
    const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    ed.selection = new vscode.Selection(n.range!.def, 4, n.range!.def, 4);   // inside the body
    const savedX = c.layout.nodes[id]?.x;
    c.panel.lastRendered = undefined;
    await vscode.commands.executeCommand('codeflow.followBackward');
    const r = await waitFor(() => c.panel.lastRendered?.visibleNodes.includes(id) && c.panel.lastRendered.visibleNodes.length < 40 && c.panel.lastRendered, 20000, 'chain render');
    assert.ok(r.visibleEdges.length > 0, 'callers wired');
    assert.ok(r.visibleEdges.every(e => /^(call|method_call|depends)\|/.test(e)), 'only call wires');
    await closeDoc(doc.uri);
    // temporary arrangement: saved positions untouched
    assert.strictEqual(c.layout.nodes[id]?.x, savedX);
  });

  test('11. detach moves the canvas to its own window and it still renders', async () => {
    c.panel.lastRendered = undefined;
    await vscode.commands.executeCommand('codeflow.detach');
    await new Promise(r => setTimeout(r, 1000));
    c.panel.post({ type: 'probe' });   // re-report even if the move kept the webview alive
    await waitFor(() => c.panel.lastRendered?.visibleNodes.length, 60000, 'render after detach')
      .catch(e => { throw new Error(`${e.message}: readyCount=${c.panel.readyCount} visible=${c.panel.visible}`); });
  });
});
