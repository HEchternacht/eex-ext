import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import type { Graph, GraphPatch } from '../../shared/graph';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Long-lived Python sidecar speaking newline-delimited JSON-RPC over stdio. */
export class AnalyzerClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private python: string, private pyRoot: string, private log: (s: string) => void) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn(this.python, ['-X', 'utf8', '-m', 'codeflow_py'], {
      cwd: this.pyRoot,
      env: { ...process.env, PYTHONPATH: this.pyRoot + path.delimiter + (process.env.PYTHONPATH ?? ''), PYTHONIOENCODING: 'utf-8' },
    });
    readline.createInterface({ input: proc.stdout }).on('line', line => this.onLine(line));
    proc.stderr.on('data', d => this.log(String(d)));
    proc.on('exit', code => {
      this.log(`analyzer exited (${code})`);
      for (const p of this.pending.values()) p.reject(new Error(`analyzer exited (${code})`));
      this.pending.clear();
    });
    this.proc = proc;
    return proc;
  }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { this.log(line); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      this.log(msg.error.data ?? msg.error.message);
      p.reject(new Error(msg.error.message));
    } else p.resolve(msg.result);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const proc = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  analyze(root: string, exclude: string[], nestSingleUse: boolean): Promise<Graph> {
    return this.request('analyze', { root, exclude, nestSingleUse });
  }

  update(files: string[]): Promise<GraphPatch> {
    return this.request('update', { files });
  }

  locate(source: string, qualname: string): Promise<{ start: number; end: number; indent: number } | null> {
    return this.request('locate', { source, qualname });
  }

  dispose() {
    this.proc?.kill();
  }
}
