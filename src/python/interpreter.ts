import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { cfg } from '../config';

/** A virtual environment inside the workspace (.venv / venv / env): holds the project's own dependencies (pytest, the app). */
export function workspaceVenv(root: string): string | undefined {
  for (const dir of ['.venv', 'venv', 'env']) {
    const exe = process.platform === 'win32' ? path.join(root, dir, 'Scripts', 'python.exe') : path.join(root, dir, 'bin', 'python');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

/** codeflow.pythonPath → workspace venv → Python extension's active interpreter → py -3 / python3 / python. */
export async function resolvePython(resource?: vscode.Uri): Promise<string> {
  const configured = cfg().pythonPath;
  if (configured) return configured;
  const venv = resource && workspaceVenv(resource.fsPath);
  if (venv) return venv;
  try {
    const { PythonExtension } = await import('@vscode/python-extension');
    if (vscode.extensions.getExtension('ms-python.python')) {
      const api = await PythonExtension.api();
      const envPath = api.environments.getActiveEnvironmentPath(resource);
      const env = await api.environments.resolveEnvironment(envPath);
      const exe = env?.executable.uri?.fsPath;
      if (exe) return exe;
    }
  } catch {
    // Python extension missing or not ready: fall through
  }
  for (const candidate of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    const exe = await probe(candidate, candidate === 'py' ? ['-3'] : []);
    if (exe) return exe;
  }
  throw new Error('No Python interpreter found. Set codeflow.pythonPath.');
}

function probe(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(cmd, [...args, '-c', 'import sys; print(sys.executable)'], { timeout: 10000 }, (err, out) =>
      resolve(err ? undefined : out.trim() || undefined));
  });
}
