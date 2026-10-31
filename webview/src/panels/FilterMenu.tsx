import { useMemo, useState } from 'react';
import type { Graph } from '../../../shared/graph';
import { edgeRules, nodeRules, relPath } from '../filters';
import { Icon } from '../nodes/CodeNode';
import { useStore } from '../store';
import { KIND_ICON } from '../theme';

interface Row { rule: string; label: string; icon: string; count: number; indent?: boolean; children?: string[] }
interface Section { title: string; rows: Row[] }

const WIRE_ICON: Record<string, string> = {
  call: 'arrow-swap', method_call: 'symbol-method', reference: 'references', decorates: 'symbol-event', depends: 'plug',
  global_read: 'symbol-variable', global_write: 'edit', flow: 'arrow-right',
};
const FLAG_LABEL: Record<string, string> = {
  'flag:resolved': 'resolved (solid)', 'flag:unresolved': 'unresolved (dashed)', 'flag:project': 'project', 'flag:library': 'library',
};

const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Everything the filter menu can show or hide, with counts, built from the graph. */
export function filterSections(g: Graph): Section[] {
  const files = new Map<string, number>(), folders = new Map<string, number>(), pkgs = new Map<string, number>();
  const kinds = new Map<string, number>(), wires = new Map<string, number>(), flags = new Map<string, number>();
  const types = new Map<string, number>(), libs = new Map<string, number>();
  const modules = [...new Set(g.nodes.map(n => n.module).filter(Boolean))] as string[];
  const isPackage = (name: string) => modules.some(m => m.startsWith(name + '.'));
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  for (const n of g.nodes) {
    const r = nodeRules(n, g.root);
    count(kinds, r.kind[0]);
    if (r.file) {
      count(files, r.file[0]);
      if (r.file.length > 1) count(folders, r.file[r.file.length - 1]);   // the file's own folder
    }
    for (const p of r.pkg ?? []) if (isPackage(p.slice(4))) count(pkgs, p);
  }
  for (const e of g.edges) {
    const r = edgeRules(e, byId);
    count(wires, r.wire[0]);
    r.flag.forEach(f => count(flags, f));
    if (r.type) count(types, r.type[0]);
    if (r.lib) count(libs, r.lib[0]);
  }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);
  const fileRows: Row[] = [];
  for (const [folder, n] of [...folders].sort()) {
    const kids = [...files.keys()].filter(f => f.startsWith(folder) && !f.slice(folder.length).includes('/')).sort();
    fileRows.push({ rule: folder, label: folder.slice(5), icon: 'folder', count: n, children: kids });
    for (const f of kids) fileRows.push({ rule: f, label: f.slice(folder.length), icon: 'file-code', count: files.get(f)!, indent: true });
  }
  for (const f of [...files.keys()].filter(f => !f.slice(5).includes('/')).sort()) {
    fileRows.push({ rule: f, label: f.slice(5), icon: 'file-code', count: files.get(f)! });
  }
  return [
    { title: 'Files', rows: fileRows },
    { title: 'Packages', rows: [...pkgs].sort().map(([rule, n]) => ({ rule, label: rule.slice(4), icon: 'package', count: n })) },
    { title: 'Libraries', rows: sorted(libs).map(([rule, n]) => ({ rule, label: rule.slice(4), icon: 'library', count: n })) },
    { title: 'Node kinds', rows: sorted(kinds).map(([rule, n]) => ({ rule, label: rule.slice(5), icon: KIND_ICON[rule.slice(5) as keyof typeof KIND_ICON] ?? 'circle', count: n })) },
    { title: 'Wire kinds', rows: sorted(wires).map(([rule, n]) => ({ rule, label: rule.slice(5).replace('_', ' '), icon: WIRE_ICON[rule.slice(5)] ?? 'dash', count: n })) },
    { title: 'Wire flags', rows: sorted(flags).map(([rule, n]) => ({ rule, label: FLAG_LABEL[rule], icon: rule.includes('unresolved') ? 'question' : rule.includes('library') ? 'library' : 'check', count: n })) },
    { title: 'Types', rows: sorted(types).slice(0, 60).map(([rule, n]) => ({ rule, label: rule.slice(5), icon: 'symbol-type-parameter', count: n })) },
  ];
}

/** Human label for an active rule chip. */
export function ruleLabel(rule: string) {
  const [cat, ...rest] = rule.split(':');
  return `${cat}: ${rest.join(':') || '(root)'}`;
}

export function FilterMenu({ onClose }: { onClose: () => void }) {
  const graph = useStore(s => s.graph);
  const filters = useStore(s => s.layout.filters);
  const setFilters = useStore(s => s.setFilters);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set(['Types', 'Packages']));
  const sections = useMemo(() => (graph ? filterSections(graph) : []), [graph]);
  const hidden = new Set(filters.hidden);
  const solo = new Set(filters.solo);

  const toggle = (row: Row) => {
    const isHidden = hidden.has(row.rule);
    let next = filters.hidden.filter(r => r !== row.rule && !(row.children ?? []).includes(r));
    if (!isHidden && !(row.children ?? []).some(c => hidden.has(c))) next = [...next, row.rule];
    setFilters({ hidden: next });
  };
  const toggleSolo = (rule: string) =>
    setFilters({ solo: solo.has(rule) ? filters.solo.filter(r => r !== rule) : [...filters.solo, rule] });
  const state = (row: Row): 'on' | 'off' | 'mixed' => {
    if (hidden.has(row.rule)) return 'off';
    if (row.indent) {
      const parent = sections[0].rows.find(r => r.children?.includes(row.rule));
      if (parent && hidden.has(parent.rule)) return 'off';
    }
    return (row.children ?? []).some(c => hidden.has(c)) ? 'mixed' : 'on';
  };
  const ql = q.trim().toLowerCase();

  return (
    <div className="cf-popover cf-filter-menu nodrag" onMouseDown={e => e.stopPropagation()}>
      <div className="cf-filter-top">
        <span className="cf-search"><Icon name="search" />
          <input autoFocus placeholder="Search filters…" value={q} onChange={e => setQ(e.target.value)} /></span>
        <button title="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <label className="cf-filter-path"><Icon name="filter" />
        <input placeholder="path contains / glob (e.g. app/services/**)" value={filters.pathFilter}
          onChange={e => setFilters({ pathFilter: e.target.value })} /></label>
      <div className="cf-filter-body">
        {sections.map(sec => {
          const rows = sec.rows.filter(r => !ql || r.label.toLowerCase().includes(ql));
          if (!rows.length) return null;
          const open = ql !== '' || !closed.has(sec.title);
          return (
            <div key={sec.title} className="cf-filter-section">
              <div className="cf-filter-title" onClick={() => setClosed(c => {
                const n = new Set(c);
                if (n.has(sec.title)) n.delete(sec.title); else n.add(sec.title);
                return n;
              })}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} /> {sec.title} <span className="cf-group-count">{sec.rows.length}</span>
              </div>
              {open && rows.map(r => {
                const st = state(r);
                return (
                  <div key={r.rule} className={`cf-filter-row ${r.indent ? 'cf-indent' : ''} ${solo.size && !solo.has(r.rule) ? 'cf-dim' : ''}`}
                    title="Click: show / hide · Alt+click: solo (show only this)"
                    onClick={e => (e.altKey ? toggleSolo(r.rule) : toggle(r))}>
                    <Icon name={st === 'on' ? 'pass-filled' : st === 'mixed' ? 'circle-large-filled' : 'circle-large-outline'} />
                    <Icon name={r.icon} />
                    <span className="cf-filter-label">{r.label}</span>
                    <span className="cf-group-count">{r.count}</span>
                    <button className={`cf-solo ${solo.has(r.rule) ? 'on' : ''}`} title="Solo: show only this (per section)"
                      onClick={e => { e.stopPropagation(); toggleSolo(r.rule); }}><Icon name="target" /></button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
