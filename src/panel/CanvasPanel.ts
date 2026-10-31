import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from '../../shared/protocol';

type Rendered = Extract<FromWebview, { type: 'rendered' }>;

/** Hosts the React Flow canvas webview and routes typed messages. */
export class CanvasPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: ToWebview[] = [];
  lastRendered: Rendered | undefined;
  readyCount = 0;   // loads of the current panel's webview (>1: it reloaded); read by tests
  private renderedWaiters: ((r: Rendered) => void)[] = [];

  constructor(private extUri: vscode.Uri, private onMessage: (m: FromWebview) => void, private onDispose: () => void) {}

  get visible() {
    return !!this.panel;
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const distWeb = vscode.Uri.joinPath(this.extUri, 'dist', 'webview');
    this.readyCount = 0;
    this.panel = vscode.window.createWebviewPanel('codeflow.canvas', 'Code Flow', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [distWeb],
    });
    this.panel.webview.html = this.html(this.panel.webview, distWeb);
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready') {
        this.ready = true;
        this.readyCount++;
        this.queue.splice(0).forEach(q => this.panel?.webview.postMessage(q));
      }
      if (m.type === 'rendered') {
        if (!m.tooltip) this.lastRendered = m;
        this.renderedWaiters.splice(0).forEach(w => w(m));
      }
      this.onMessage(m);
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
      this.onDispose();
    });
  }

  post(msg: ToWebview) {
    if (!this.panel) return;
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  /** Tests: resolves with the next 'rendered' report from the webview. */
  nextRendered(): Promise<Rendered> {
    return new Promise(resolve => this.renderedWaiters.push(resolve));
  }

  dispose() {
    this.panel?.dispose();
  }

  private html(webview: vscode.Webview, distWeb: vscode.Uri) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(distWeb, 'index.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(distWeb, 'index.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; worker-src blob:;">
<link rel="stylesheet" href="${css}">
<title>Code Flow</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" type="module" src="${js}"></script></body>
</html>`;
  }
}
