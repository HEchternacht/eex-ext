import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InjectRequest, InjectResult, PauseInfo, ToWebview, TraceControl, TraceEvent } from '../../shared/protocol';
import { cfg } from '../config';
import { TraceTarget, attachScript, detectEntryPoints, injectTarget, launchTargets, pytestTarget, tracerArgs } from './launchers';
import { TraceServer, type TracerMessage } from './traceServer';

const STATE_KEY = 'codeflow.lastTraceValues';

export interface TraceHost {
  root: vscode.Uri;
  pyRoot: string;
  python(): Promise<string>;
  knownNode(id: string): boolean;
  post(events: TraceEvent[]): void;
  send(msg: ToWebview): void;
  running(r: boolean): void;
  log(s: string): void;
  state: vscode.Memento;
}

/** Runs targets under the tracer (as VS Code tasks), owns the socket server, forwards events. */
export class TraceSession implements vscode.Disposable {
  private server: TraceServer | undefined;
  private executions = new Set<vscode.TaskExecution>();
  private attached: { python: string; pid: number }[] = [];
  private latest = new Map<string, TraceEvent>();
  private disposables: vscode.Disposable[] = [];
  readonly received: TraceEvent[] = [];   // tests: everything forwarded during this session
  readonly pausesSeen: (PauseInfo & { at: number })[] = [];   // tests
  readonly injectedSeen: InjectResult[] = [];                  // tests
  private control: TraceControl = { intercept: [], follow: false, followNodes: null };
  private injectIds = 0;
  private freshInjects = new Set<number>();

  constructor(private host: TraceHost) {
    this.disposables.push(vscode.tasks.onDidEndTaskProcess(e => {
      if (this.executions.delete(e.execution)) {
        this.host.log(`trace task ended (exit ${e.exitCode})`);
        this.updateRunning();
      }
    }));
  }

  get running() {
    return this.executions.size > 0 || this.attached.length > 0;
  }

  private updateRunning() {
    this.host.running(this.running);
    if (!this.running) this.saveValues();
  }

  private async ensureServer() {
    if (!this.server) {
      this.server = new TraceServer(evs => this.onEvents(evs), cfg().trace.flushMs, this.host.log,
        m => this.onMessage(m), conn => this.sendConfig(conn));
      await this.server.start();
    }
    return this.server;
  }

  private onEvents(events: TraceEvent[]) {
    const known = events.filter(e => this.host.knownNode(e.node));
    if (!known.length) return;
    for (const e of known) {
      this.latest.set(`${e.t}|${e.node}|${e.caller ?? ''}|${e.port ?? ''}`, e);
      this.received.push(e);
    }
    if (this.received.length > 50000) this.received.splice(0, this.received.length - 50000);
    this.host.post(known);
  }

  private sendConfig(conn?: number) {
    this.server?.send({ cmd: 'config', ...this.control, timeout: cfg().interceptTimeoutSec }, conn);
  }

  /** Intercepts and follow mode, from the canvas; applied to running tracers at once and to new ones on connect. */
  setControl(control: TraceControl) {
    this.control = control;
    this.sendConfig();
  }

  private onMessage(m: TracerMessage) {
    if ('pause' in m) {
      const pause: PauseInfo = { ...m.pause, key: `${m.conn}:${m.pause.id}` };
      this.pausesSeen.push({ ...pause, at: Date.now() });
      this.host.send({ type: 'pause', pause });
    } else if ('resumed' in m) {
      this.host.send({ type: 'resumed', key: `${m.conn}:${m.resumed.id}`, why: m.resumed.why });
    } else if ('injected' in m) {
      const r = m.injected;
      const where = this.freshInjects.delete(r.id) ? 'fresh' : 'live';
      this.host.log(`inject ${r.node}: ${r.ok ? r.value?.value : r.error}`);
      this.injectedSeen.push({ ...r, where });
      this.host.send({ type: 'injected', result: { ...r, where } });
    } else if ('error' in m) {
      this.host.log(`tracer: ${m.error.message}`);
      this.host.send({ type: 'traceError', message: m.error.message });
    }
  }

  resume(key: string, args?: Record<string, string>) {
    const [conn, id] = key.split(':').map(Number);
    this.server?.send({ cmd: 'resume', id, args }, conn);
  }

  abort(key: string) {
    const [conn, id] = key.split(':').map(Number);
    this.server?.send({ cmd: 'abort', id }, conn);
  }

  /** Call a function: in the running traced program if there is one (and target is 'auto'), else in a fresh process. */
  async inject(req: InjectRequest) {
    const id = ++this.injectIds;
    const spec = { id, args: req.args, kwargs: req.kwargs, self: req.self || null };
    if (req.target === 'auto' && this.server?.connections) {
      this.server.send({ cmd: 'inject', node: req.node, ...spec });
      return;
    }
    this.freshInjects.add(id);
    await this.run(injectTarget(this.host.root.fsPath, req.node, spec));
  }

  private options(server: TraceServer) {
    const c = cfg();
    return {
      port: server.port, token: server.token, root: this.host.root.fsPath, maxRepr: c.trace.maxValueLength,
      flushMs: c.trace.flushMs, globals: c.trace.globals, exclude: c.exclude,
      valueDepth: c.trace.valueDepth, valueItems: c.trace.valueItems,
    };
  }

  async run(target: TraceTarget): Promise<vscode.TaskExecution> {
    const server = await this.ensureServer();
    const python = await this.host.python();
    const args = tracerArgs(this.options(server), target);
    const env = { ...target.env, PYTHONPATH: [this.host.pyRoot, process.env.PYTHONPATH, target.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
    const folder = vscode.workspace.getWorkspaceFolder(this.host.root) ?? vscode.TaskScope.Workspace;
    const task = new vscode.Task({ type: 'codeflow-trace', target: target.label }, folder, `trace: ${target.label}`, 'codeflow',
      new vscode.ProcessExecution(python, args, { cwd: target.cwd, env }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    const exec = await vscode.tasks.executeTask(task);
    this.executions.add(exec);
    this.updateRunning();
    return exec;
  }

  async traceTests() {
    const python = await this.host.python();
    try {
      await run(python, ['-c', 'import pytest']);
    } catch {
      const pick = await vscode.window.showErrorMessage(
        `Code Flow: pytest is not installed for ${python}. Install it there, or pick the project's interpreter.`,
        'Select Interpreter', 'Set codeflow.pythonPath');
      if (pick === 'Select Interpreter') void vscode.commands.executeCommand('python.setInterpreter');
      if (pick === 'Set codeflow.pythonPath') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeflow.pythonPath');
      return;
    }
    return this.run(pytestTarget(this.host.root.fsPath));
  }

  /** launch.json configurations, plus entry points found in the source (picking one saves it to launch.json). */
  async traceLaunch(name?: string): Promise<vscode.TaskExecution | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(this.host.root);
    if (!folder) return;
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const existing = launch.get<any[]>('configurations') ?? [];
    const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.py'), `{${cfg().exclude.join(',')}}`))
      .map(u => u.fsPath).sort();
    const detected = detectEntryPoints(folder.uri.fsPath, files)
      .filter(d => !existing.some(c => c.program === d.program && c.module === d.module && String(c.args) === String(d.args)));
    const items = [
      ...launchTargets(folder).map(t => ({ label: t.label, detail: t.args.join(' '), t, save: undefined })),
      ...detected.map(d => ({ label: d.name, description: 'found in the source · saved to launch.json', detail: [d.module ? `-m ${d.module}` : d.program, ...(d.args ?? [])].join(' '),
        t: launchTargets(folder, [d])[0], save: d })),
    ];
    if (!items.length) {
      const pick = await vscode.window.showWarningMessage(
        'Code Flow: nothing to launch found (no launch.json config, `if __name__ == "__main__"`, __main__.py or web app).', 'Trace Tests Instead', 'Open launch.json');
      if (pick === 'Trace Tests Instead') return this.traceTests() as Promise<vscode.TaskExecution | undefined>;
      if (pick === 'Open launch.json') void vscode.commands.executeCommand('workbench.action.debug.configure');
      return;
    }
    const pick = name !== undefined ? items.find(i => i.label === name) : items.length === 1 && !items[0].save ? items[0]
      : await vscode.window.showQuickPick(items, { title: 'Code Flow: trace which program?' });
    if (!pick) return;
    if (pick.save) await launch.update('configurations', [...existing, pick.save], vscode.ConfigurationTarget.WorkspaceFolder);
    return this.run(pick.t);
  }

  /** Python 3.14+: inject the tracer into a running process with sys.remote_exec. */
  async attach(pid?: number) {
    const python = await this.host.python();
    const version = await run(python, ['-c', 'import sys;print(sys.version_info >= (3, 14))']);
    if (version.trim() !== 'True') {
      void vscode.window.showWarningMessage('Code Flow: attaching needs Python 3.14+ (sys.remote_exec). Use "Trace Launch Config" instead.');
      return;
    }
    if (pid === undefined) {
      const input = await vscode.window.showInputBox({ prompt: 'PID of the running Python process', validateInput: v => /^\d+$/.test(v) ? null : 'number' });
      if (!input) return;
      pid = Number(input);
    }
    const server = await this.ensureServer();
    await this.remoteExec(python, pid, attachScript(this.host.pyRoot, this.options(server)));
    this.attached.push({ python, pid });
    this.updateRunning();
  }

  private async remoteExec(python: string, pid: number, code: string) {
    const file = path.join(os.tmpdir(), `codeflow-attach-${pid}-${Date.now()}.py`);
    fs.writeFileSync(file, code, 'utf8');
    await run(python, ['-c', `import sys; sys.remote_exec(${pid}, ${JSON.stringify(file)})`]);
  }

  async stop() {
    for (const e of this.executions) e.terminate();
    for (const a of this.attached.splice(0)) {
      await this.remoteExec(a.python, a.pid, `import sys\nsys.path.append(${JSON.stringify(this.host.pyRoot)})\nfrom codeflow_py.trace import stop\nstop()\n`)
        .catch(e => this.host.log(`detach failed: ${e}`));
    }
    this.updateRunning();
  }

  /** trace.persistValues: last values survive a reload (workspace state, never the layout file). */
  private saveValues() {
    if (cfg().trace.persistValues) void this.host.state.update(STATE_KEY, [...this.latest.values()]);
  }

  restoredValues(): TraceEvent[] {
    return cfg().trace.persistValues ? this.host.state.get<TraceEvent[]>(STATE_KEY, []) : [];
  }

  dispose() {
    void this.stop();
    this.server?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));
}
