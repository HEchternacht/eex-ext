import { useEffect, useRef } from 'react';
import { Icon } from '../nodes/CodeNode';

export interface MenuItem { label: string; icon: string; run: () => void; shortcut?: string; disabled?: boolean }
export type MenuEntry = MenuItem | '-';
export interface MenuState { x: number; y: number; items: MenuEntry[] }

/** VS Code-looking context menu; closes on pick, Escape, outside click or scroll. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  // keep inside the window
  const x = Math.min(menu.x, window.innerWidth - 280);
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 24 - 12);
  return (
    <div ref={ref} className="cf-menu" style={{ left: Math.max(0, x), top: Math.max(0, y) }} onContextMenu={e => e.preventDefault()}>
      {menu.items.map((it, i) => it === '-'
        ? <div key={i} className="cf-menu-sep" />
        : (
          <div key={i} className={`cf-menu-item ${it.disabled ? 'disabled' : ''}`}
            onClick={() => { if (it.disabled) return; onClose(); it.run(); }}>
            <Icon name={it.icon} />
            <span className="cf-menu-label">{it.label}</span>
            {it.shortcut && <span className="cf-menu-key">{it.shortcut}</span>}
          </div>
        ))}
    </div>
  );
}
