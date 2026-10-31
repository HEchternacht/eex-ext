import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface TraceTarget {
  label: string;
  args: string[];              // after '--': ['-m', 'pytest', ...] or ['script.py', ...]
  cwd: string;
  env: Record<string, string>;
}

/** python -m codeflow_py.trace [options] -- <target> */
export interface TracerOptions { port: number; token: string; root: string; maxRepr: number; flushMs: number;
  globals: boolean; exclude: string[]; valueDepth: number; valueItems: number }

export function tracerArgs(opts: TracerOptions, target: TraceTarget): string[] {
  return [
    '-X', 'utf8', '-m', 'codeflow_py.trace',
    '--port', String(opts.port), '--token', opts.token, '--root', opts.root,
    '--max-repr', String(opts.maxRepr), '--flush-ms', String(opts.flushMs),
    '--value-depth', String(opts.valueDepth), '--value-items', String(opts.valueItems),
    ...(opts.globals ? ['--globals'] : []),
    ...opts.exclude.flatMap(e => ['--exclude', e.startsWith('/') || e.startsWith('**') ? e : '/' + e]),
    '--', ...target.args,
  ];
}

export function pytestTarget(root: string): TraceTarget {
  return { label: 'pytest', args: ['-m', 'pytest'], cwd: root, env: {} };
}

/** A fresh process that calls one function (Inject into a program that isn't running). */
export function injectTarget(root: string, node: string, spec: object): TraceTarget {
  return { label: `inject ${node.split('.').pop()}`, args: ['-m', 'codeflow_py.inject', node, JSON.stringify(spec)], cwd: root, env: { PYTHONPATH: root } };
}

/** Python launch configurations from launch.json, translated into tracer targets. */
export function launchTargets(folder: vscode.WorkspaceFolder,
  configs = vscode.workspace.getConfiguration('launch', folder.uri).get<any[]>('configurations') ?? []): TraceTarget[] {
  const root = folder.uri.fsPath;
  const sub = (s: string) => s
    .replace(/\$\{workspaceFolder\}/g, root)
    .replace(/\$\{workspaceFolderBasename\}/g, path.basename(root))
    .replace(/\$\{file\}/g, vscode.window.activeTextEditor?.document.uri.fsPath ?? '')
    .replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] ?? '');
  return configs
    .filter(c => (c.type === 'python' || c.type === 'debugpy') && c.request === 'launch' && (c.program || c.module))
    .map(c => ({
      label: c.name ?? c.module ?? c.program,
      args: [...(c.module ? ['-m', sub(c.module)] : [sub(c.program)]),
        ...(Array.isArray(c.args) ? c.args : typeof c.args === 'string' ? c.args.split(' ') : []).map((a: string) => sub(a))],
      cwd: c.cwd ? sub(c.cwd) : root,
      env: Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, sub(String(v))])),
    }));
}

export interface LaunchConfig { name: string; type: 'debugpy'; request: 'launch'; program?: string; module?: string; args?: string[] }

/** Entry points found in the source, as launch.json configurations: `if __name__ == "__main__"` scripts,
 * packages with __main__.py, module-level ASGI (FastAPI / Starlette, run with uvicorn) and Flask apps. */
export function detectEntryPoints(root: string, files: string[]): LaunchConfig[] {
  const out: LaunchConfig[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const module = rel.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (path.basename(file) === '__main__.py' && rel.includes('/')) {
      const pkg = module.replace(/\.__main__$/, '');
      out.push({ name: `${pkg} (python -m)`, type: 'debugpy', request: 'launch', module: pkg });
    } else if (/^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text)) {
      out.push({ name: rel, type: 'debugpy', request: 'launch', program: `\${workspaceFolder}/${rel}` });
    }
    const app = /^(\w+)\s*(?::[^=]+)?=\s*(\w+(?:\.\w+)*)\(/gm;
    for (const m of text.matchAll(app)) {
      const [, name, ctor] = m;
      if (/(^|\.)(FastAPI|Starlette)$/.test(ctor) || /^create_app$|_app$/.test(ctor) && /\b(fastapi|starlette)\b/.test(text)) {
        out.push({ name: `${module}:${name} (uvicorn)`, type: 'debugpy', request: 'launch', module: 'uvicorn', args: [`${module}:${name}`] });
      } else if (/(^|\.)Flask$/.test(ctor)) {
        out.push({ name: `${module}:${name} (flask)`, type: 'debugpy', request: 'launch', module: 'flask', args: ['--app', `${module}:${name}`, 'run', '--no-reload'] });
      }
    }
  }
  return out;
}

/** Script handed to sys.remote_exec (Python 3.14+) to start tracing inside a running process. */
export function attachScript(pyRoot: string, opts: TracerOptions): string {
  return [
    'import sys',
    `sys.path.append(${JSON.stringify(pyRoot)})`,
    'from codeflow_py.trace import start',
    'from codeflow_py.trace.core import Options',
    `start(Options(${opts.port}, ${JSON.stringify(opts.token)}, ${JSON.stringify(opts.root)}, ${opts.maxRepr}, ` +
      `${opts.flushMs}, ${opts.globals ? 'True' : 'False'}, ${JSON.stringify(opts.exclude)}, ${opts.valueDepth}, ${opts.valueItems}))`,
    '',
  ].join('\n');
}
