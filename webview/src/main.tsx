import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { Component, type ReactNode } from 'react';
import { App } from './App';
import { post } from './vscode';

const report = (message: string) => post({ type: 'error', message });
window.addEventListener('error', e => report(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => report(`unhandled rejection: ${e.reason?.stack ?? e.reason}`));
// a stalled canvas drops nothing visibly: report main-thread blocks with the last message handled
new PerformanceObserver(l => l.getEntries().forEach(e => e.duration > 1500 &&
  report(`main thread blocked ${Math.round(e.duration)} ms (last message: ${(window as { cfLast?: string }).cfLast})`)))
  .observe({ type: 'longtask', buffered: true });

/** A render error must not leave a blank, deaf canvas: show it, report it, offer a reload. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.stack ?? String(e) };
  }
  componentDidCatch(e: Error) {
    report(`render error: ${e.stack ?? e}`);
  }
  render() {
    return this.state.error
      ? <div className="cf-crash"><h3>Code Flow canvas hit an error</h3><pre>{this.state.error}</pre>
          <button onClick={() => post({ type: 'command', name: 'reload' })}>Reload canvas</button></div>
      : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
