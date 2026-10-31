import * as path from 'path';
import * as vscode from 'vscode';

export const SCHEME = 'codeflow';

export interface Located { start: number; end: number; indent: number }
type Locate = (source: string, qualname: string) => Promise<Located | null>;

/**
 * Virtual documents holding exactly one function/class: codeflow:/<file name>/<qualname>.py?<encoded real path>.
 * Reads slice the real document (open editor text if any, so unsaved edits are respected); writes splice back.
 */
export class FunctionFileSystem implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private qualnames = new Map<string, string>();     // virtual uri -> current qualname (follows renames)
  private mtimes = new Map<string, number>();
  private lastLoc = new Map<string, Located>();     // fallback while the real file does not parse

  constructor(private locate: Locate) {}

  static uriFor(file: string, qualname: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}/${qualname}.py`, query: encodeURIComponent(file) });
  }

  static realFile(uri: vscode.Uri): string {
    return decodeURIComponent(uri.query);
  }

  private qualname(uri: vscode.Uri): string {
    return this.qualnames.get(uri.toString()) ?? path.posix.basename(uri.path, '.py');
  }

  private async realDocument(uri: vscode.Uri) {
    return vscode.workspace.openTextDocument(vscode.Uri.file(FunctionFileSystem.realFile(uri)));
  }

  private async slice(uri: vscode.Uri) {
    const doc = await this.realDocument(uri);
    const text = doc.getText();
    let loc: Located | null;
    try {
      loc = await this.locate(text, this.qualname(uri));
    } catch {
      loc = this.lastLoc.get(uri.toString()) ?? null;   // syntax error in the file: keep the last known slice
    }
    if (!loc) throw vscode.FileSystemError.FileNotFound(uri);
    this.lastLoc.set(uri.toString(), loc);
    const lines = text.split(/\r?\n/).slice(loc.start - 1, loc.end);
    return { doc, loc, body: lines.map(l => l.slice(Math.min(loc.indent, l.length - l.trimStart().length))).join('\n') + '\n' };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { body } = await this.slice(uri);
    const key = uri.toString();
    if (!this.mtimes.has(key)) this.mtimes.set(key, Date.now());   // stable, or VS Code reports save conflicts
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtimes.get(key)!, size: Buffer.byteLength(body) };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from((await this.slice(uri)).body, 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { doc, loc } = await this.slice(uri);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const pad = ' '.repeat(loc.indent);
    const lines = Buffer.from(content).toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    const text = lines.map(l => (l.trim() ? pad + l : '')).join(eol);
    const range = new vscode.Range(loc.start - 1, 0, loc.end - 1, doc.lineAt(loc.end - 1).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, text);
    if (!(await vscode.workspace.applyEdit(edit))) throw vscode.FileSystemError.Unavailable(uri);
    this.lastLoc.set(uri.toString(), { ...loc, end: loc.start + lines.length - 1 });
    await doc.save();
    // follow a rename of the def/class itself
    const m = /^\s*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/m.exec(lines.find(l => /^\s*(async\s+def|def|class)\s/.test(l)) ?? '');
    if (m) {
      const parts = this.qualname(uri).split('.');
      parts[parts.length - 1] = m[1];
      this.qualnames.set(uri.toString(), parts.join('.'));
    }
    this.mtimes.set(uri.toString(), Date.now());
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /** Real file changed elsewhere: tell VS Code to reload open slices of it. */
  realFileChanged(file: string) {
    const changed = vscode.workspace.textDocuments
      .filter(d => d.uri.scheme === SCHEME && path.normalize(FunctionFileSystem.realFile(d.uri)).toLowerCase() === path.normalize(file).toLowerCase())
      .map(d => ({ type: vscode.FileChangeType.Changed, uri: d.uri }));
    changed.forEach(c => this.mtimes.set(c.uri.toString(), Date.now()));
    if (changed.length) this.emitter.fire(changed);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}
