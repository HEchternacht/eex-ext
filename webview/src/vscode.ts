import type { FromWebview } from '../../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };

export function post(m: FromWebview) {
  api.postMessage(m);
}
