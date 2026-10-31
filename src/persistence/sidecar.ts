import * as vscode from 'vscode';
import { LayoutState, emptyLayout, normalizeLayout } from '../../shared/layout';

/** .vscode/codeflow.json — node positions, filters, locked wires, viewport. Never trace values. */
export class Sidecar {
  private timer: NodeJS.Timeout | undefined;
  private pendingState: LayoutState | undefined;

  constructor(private root: vscode.Uri) {}

  get uri() {
    return vscode.Uri.joinPath(this.root, '.vscode', 'codeflow.json');
  }

  async load(): Promise<LayoutState> {
    return readLayout(this.uri);
  }

  /** Debounced write (500 ms). */
  save(state: LayoutState) {
    this.pendingState = state;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.timer);
    const state = this.pendingState;
    this.pendingState = undefined;
    if (state) await writeLayout(this.uri, state);
  }
}

export async function readLayout(uri: vscode.Uri): Promise<LayoutState> {
  try {
    return normalizeLayout(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')));
  } catch {
    return emptyLayout();
  }
}

export async function writeLayout(uri: vscode.Uri, state: LayoutState) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state, null, 1), 'utf8'));
}
