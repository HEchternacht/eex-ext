import { useState } from 'react';
import { DEFAULT_FILTERS } from '../../../shared/layout';
import type { Focus } from '../filters';
import { Icon } from '../nodes/CodeNode';
import { post } from '../vscode';
import { useStore } from '../store';
import { FilterMenu, ruleLabel } from './FilterMenu';

const LEVEL_HELP: Record<string, string[]> = {
  In: [
    'Level 1 in: arguments coming into a function (and values from Depends).',
    'Level 2 in: return values coming back from plain functions it calls.',
    'Level 3 in: return values from methods it calls, and globals it reads.',
  ],
  Out: [
    'Level 1 out: its return value, going back to whoever called it.',
    'Level 2 out: calls it makes to plain functions.',
    'Level 3 out: calls it makes to methods, and globals it writes.',
  ],
};

const MODE_HELP = {
  relative: 'Relative mode: levels are read from the selected node. With nothing selected, a wire shows when its level is on for both In and Out.',
  fixed: 'Fixed mode: every wire has one level, whatever is selected.',
};

function LevelPicker({ label, value, onChange, mode }: { label: 'In' | 'Out'; value: number[]; onChange: (v: number[]) => void; mode: 'relative' | 'fixed' }) {
  const all = value.length === 3;
  const tip = (l: number) => `${LEVEL_HELP[label][l - 1]}
Click: only this level · Ctrl/Shift+click: add or remove it.
${MODE_HELP[mode]}`;
  return (
    <span className="cf-group cf-levels">
      <span className="cf-level-label" title={`${label === 'In' ? 'What flows into nodes' : 'What flows out of nodes'}.
${MODE_HELP[mode]}`}>{label}</span>
      <button className={all ? 'on' : ''} title={`Show every ${label === 'In' ? 'input' : 'output'} level.`} onClick={() => onChange([1, 2, 3])}>All</button>
      {[1, 2, 3].map(l => (
        <button key={l} className={`cf-lvl-btn cf-lvl-btn-${l} ${value.includes(l) ? 'on' : ''}`} title={tip(l)}
          onClick={e => {
            // click = only this level; ctrl/shift-click = add/remove from the set
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              const next = value.includes(l) ? value.filter(x => x !== l) : [...value, l].sort();
              onChange(next.length ? next : [l]);
            } else onChange([l]);
          }}>{l}</button>
      ))}
    </span>
  );
}

function focusLabel(f: Focus) {
  if ('edge' in f) return "only this wire's two ends";
  const name = f.node.split('.').pop();
  if ('chain' in f) return f.chain === 'forward' ? `everything ${name} calls` : `everything that calls ${name}`;
  return f.dir === 'all' ? `only ${name}'s wires` : `only ${f.dir === 'in' ? 'inputs' : 'outputs'} of ${name}`;
}

function FollowControls({ onStep }: { onStep: () => void }) {
  const follow = useStore(s => s.follow);
  const hold = useStore(s => s.followHold);
  const waiting = useStore(s => s.pauses.filter(p => p.reason === 'follow').length);
  const stepMs = useStore(s => s.followStepMs ?? s.settings.followStepMs);
  const scope = useStore(s => s.settings.followScope);
  const st = useStore.getState;
  return (
    <span className="cf-group cf-follow">
      <button className={follow ? 'on' : ''} onClick={() => st().setFollow(!follow)}
        title={`Follow mode: the camera follows the ball and the traced program waits at each step until the animation catches up.
Scope: ${scope} (setting codeflow.follow.scope). Works with or without intercepts.`}>
        <Icon name="eye" /> Follow</button>
      {follow && <>
        <button title={hold ? 'Resume (F5)' : 'Hold: stop acknowledging steps (the program waits)'} onClick={() => st().setFollowHold(!hold)}>
          <Icon name={hold ? 'debug-continue' : 'debug-pause'} /></button>
        <button title="Step: let one call / return through (F10)" disabled={!hold || !waiting} onClick={onStep}><Icon name="debug-step-over" /></button>
        <input className="cf-speed" type="range" min={100} max={2000} step={50} value={stepMs} title={`${stepMs} ms per step`}
          onChange={e => st().setFollowStepMs(Number(e.target.value))} />
        {waiting > 0 && <span className="cf-waiting" title="Steps the program is waiting on">⏸ {waiting}</span>}
      </>}
    </span>
  );
}

export function FilterBar({ onFit, onCollapseAll, onGuide, onStep }: { onFit: () => void; onCollapseAll: (c: boolean) => void; onGuide: () => void; onStep: () => void }) {
  const filters = useStore(s => s.layout.filters);
  const groupByFile = useStore(s => s.settings.groupByFile);
  const setFilters = useStore(s => s.setFilters);
  const status = useStore(s => s.status);
  const traceRunning = useStore(s => s.traceRunning);
  const selected = useStore(s => s.selected);
  const levelMode = useStore(s => s.settings.levelMode);
  const autoWires = useStore(s => s.autoWires);
  const focus = useStore(s => s.focus);
  const setFocus = useStore(s => s.setFocus);
  const [menu, setMenu] = useState(false);
  const active = filters.hidden.length + filters.solo.length + (filters.pathFilter.trim() ? 1 : 0);
  const chips = [
    ...filters.hidden.map(r => ({ key: `h${r}`, icon: 'eye-closed', text: ruleLabel(r), clear: () => setFilters({ hidden: filters.hidden.filter(x => x !== r) }) })),
    ...filters.solo.map(r => ({ key: `s${r}`, icon: 'target', text: `only ${ruleLabel(r)}`, clear: () => setFilters({ solo: filters.solo.filter(x => x !== r) }) })),
    ...(filters.pathFilter.trim() ? [{ key: 'path', icon: 'filter', text: `path: ${filters.pathFilter}`, clear: () => setFilters({ pathFilter: '' }) }] : []),
    ...(focus ? [{ key: 'focus', icon: 'eye', text: focusLabel(focus), clear: () => setFocus(null) }] : []),
  ];
  return (
    <>
    <div className="cf-bar">
      <span className="cf-group cf-anchor">
        <button className={active ? 'on' : ''} title="Show / hide nodes and wires by file, package, kind, type…" onClick={() => setMenu(m => !m)}>
          <Icon name="filter" /> Filters{active ? ` · ${active}` : ''}
        </button>
        {menu && <FilterMenu onClose={() => setMenu(false)} />}
      </span>
      <LevelPicker label="In" mode={levelMode} value={filters.inputLevels} onChange={v => setFilters({ inputLevels: v })} />
      <LevelPicker label="Out" mode={levelMode} value={filters.outputLevels} onChange={v => setFilters({ outputLevels: v })} />
      <span className="cf-group">
        <label title="ignore_library_connections: hide wires to third-party and stdlib code">
          <input type="checkbox" checked={filters.ignoreLibraryConnections}
            onChange={e => setFilters({ ignoreLibraryConnections: e.target.checked })} /> no libs
        </label>
        <label title="Show only the selected node and its neighbours">
          <input type="checkbox" checked={filters.neighboursOnly}
            onChange={e => setFilters({ neighboursOnly: e.target.checked })} /> neighbours
        </label>
        <label title="Hide wires until a node is selected; locked wires stay visible">
          <input type="checkbox" checked={filters.wiresOnDemand || autoWires} disabled={autoWires}
            onChange={e => setFilters({ wiresOnDemand: e.target.checked })} /> wires on demand{autoWires ? ' (auto: many wires)' : ''}
        </label>
        <label title="One area per file (off: flat left-to-right flow). Positions are kept per mode.">
          <input type="checkbox" checked={groupByFile}
            onChange={e => post({ type: 'setGroupByFile', value: e.target.checked })} /> group by file
        </label>
      </span>
      <span className="cf-group">
        <button onClick={onFit}>Fit</button>
        <button title="Place every node again (left: entry points, right: what they call)" onClick={() => post({ type: 'command', name: 'relayout' })}>Re-layout</button>
        <button onClick={() => onCollapseAll(true)}>Collapse all</button>
        <button onClick={() => onCollapseAll(false)}>Expand all</button>
        <button onClick={() => post({ type: 'command', name: 'reanalyse' })}>Re-analyse</button>
        <button title="One-page guide: what everything means" onClick={onGuide}><Icon name="question" /> Guide</button>
        <button title="Open the canvas in its own window (maximise it or move it to another monitor)" onClick={() => post({ type: 'command', name: 'detach' })}>
          <Icon name="link-external" /> Detach</button>
        <FollowControls onStep={onStep} />
        {traceRunning
          ? <button className="cf-stop" onClick={() => post({ type: 'command', name: 'stopTrace' })}>■ Stop trace</button>
          : <>
              <button onClick={() => post({ type: 'command', name: 'traceTests' })}>▶ Trace tests</button>
              <button onClick={() => post({ type: 'command', name: 'traceLaunch' })}>▶ Trace launch…</button>
            </>}
      </span>
      <span className="cf-status">
        {status.busy && <span className="cf-spinner" />}
        {status.text}
        {selected && <span className="cf-tip-meta"> · {levelMode} levels from {selected.split('.').pop()}</span>}
      </span>
    </div>
    {chips.length > 0 && (
      <div className="cf-chips">
        {chips.map(c => (
          <span key={c.key} className="cf-active-chip"><Icon name={c.icon} />{c.text}
            <button title="Remove" onClick={c.clear}><Icon name="close" /></button></span>
        ))}
        <button className="cf-reset" onClick={() => { setFilters({ hidden: [], solo: [], pathFilter: DEFAULT_FILTERS.pathFilter }); setFocus(null); }}>Reset all</button>
      </div>
    )}
    </>
  );
}
