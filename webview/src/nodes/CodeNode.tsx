import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import type { GraphNode, Port } from '../../../shared/graph';
import { portGroups } from '../filters';
import { DOC_H, HEADER_H, ROW_H } from '../layout';
import { useStore } from '../store';
import { KIND_ICON, typeColor, typeKind } from '../theme';

export interface CodeNodeData extends Record<string, unknown> {
  node: GraphNode;
  hasChildren: boolean;
  collapsed: boolean;
  childCount: number;
}

export const Icon = ({ name, title }: { name: string; title?: string }) => <i className={`codicon codicon-${name}`} title={title} />;

/** Port shape: grid = *args/**kwargs, diamond = callable passed as value, hollow = has a default, else filled. */
function shape(p: Port): string {
  if (p.name.startsWith('*')) return 'grid';
  if (typeKind(p.type) === 'callable') return 'diamond';
  return p.default !== undefined ? 'hollow' : 'circle';
}

function PortHandle({ p, type, position }: { p: Port; type: 'source' | 'target'; position: Position }) {
  return <Handle type={type} position={position} id={p.id} className={`cf-handle cf-shape-${shape(p)}`} style={{ color: typeColor(p.type) }} />;
}

const ArrowHandle = ({ type, id }: { type: 'source' | 'target'; id: string }) => (
  <Handle type={type} position={type === 'target' ? Position.Left : Position.Right} id={id} className="cf-handle cf-shape-arrow" />
);

/** Chips after the name: async, @decorators (short), static/class. */
function chips(n: GraphNode): string[] {
  const out = n.isAsync ? ['async'] : [];
  for (const d of n.decorators ?? []) out.push('@' + d.split('(')[0].split('.').pop());
  return out;
}

export const firstLine = (doc?: string) => doc?.split('\n').find(l => l.trim())?.trim();

function CollapseButton({ id, collapsed }: { id: string; collapsed: boolean }) {
  const toggleCollapse = useStore(s => s.toggleCollapse);
  return (
    <button className="cf-collapse nodrag" onClick={e => { e.stopPropagation(); toggleCollapse(id); }}
      title={collapsed ? 'Expand' : 'Collapse'}><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} /></button>
  );
}

function useNodeState(id: string) {
  const glowing = useStore(s => s.glow[id]);
  const values = useStore(s => s.nodeValues[id]);
  return { glowing, values };
}

function FunctionBody({ node, hasChildren, collapsed }: CodeNodeData) {
  const { values } = useNodeState(node.id);
  const args = node.ports.filter(p => p.role === 'arg');
  const ret = node.ports.find(p => p.role === 'return');
  const doc = firstLine(node.doc);
  return (
    <>
      <div className="cf-header" style={{ height: HEADER_H }}>
        <ArrowHandle type="target" id="in" />
        <Icon name={KIND_ICON[node.kind]} />
        <span className="cf-label">{node.label}</span>
        {chips(node).map(c => <span key={c} className="cf-chip">{c}</span>)}
        {hasChildren && <CollapseButton id={node.id} collapsed={collapsed} />}
        <ArrowHandle type="source" id="calls" />
      </div>
      {doc && <div className="cf-doc" style={{ height: DOC_H }}>{doc}</div>}
      {args.map(p => {
        const v = values?.args?.find(a => a.name === p.name);
        return (
          <div className="cf-row" key={p.id} style={{ height: ROW_H }} title={v ? `${v.type}: ${v.value}` : p.type ?? ''}>
            <PortHandle p={p} type="target" position={Position.Left} />
            <span className="cf-port-name">{p.name}</span>
            <span className="cf-port-type" style={{ color: typeColor(p.type) }}>{p.type}</span>
            {p.default !== undefined && <span className="cf-port-default">= {p.default}</span>}
          </div>
        );
      })}
      {ret && (
        <div className="cf-row cf-row-out" style={{ height: ROW_H }}
          title={values?.ret ? `${values.ret.type}: ${values.ret.value}` : ret.type ?? ''}>
          <span className="cf-port-type" style={{ color: typeColor(ret.type) }}>{ret.type}</span>
          <span className="cf-port-name">return</span>
          <PortHandle p={ret} type="source" position={Position.Right} />
        </div>
      )}
    </>
  );
}

function LambdaBody({ node }: CodeNodeData) {
  const ret = node.ports.find(p => p.role === 'return');
  return (
    <div className="cf-pill-row" style={{ height: ROW_H + 4 }}>
      <ArrowHandle type="target" id="in" />
      {node.ports.filter(p => p.role === 'arg').map(p => <PortHandle key={p.id} p={p} type="target" position={Position.Left} />)}
      <span className="cf-lambda-mark">λ</span>
      <span className="cf-label cf-mono">{node.signature?.replace(/^lambda\s*/, '') || node.label}</span>
      {ret && <PortHandle p={ret} type="source" position={Position.Right} />}
      <ArrowHandle type="source" id="calls" />
    </div>
  );
}

function ClassBody({ node, hasChildren, collapsed, childCount }: CodeNodeData) {
  const fields = node.fields ?? [];
  const container = hasChildren && !collapsed;
  return (
    <>
      <div className="cf-header" style={{ height: HEADER_H }}>
        <ArrowHandle type="target" id="in" />
        <Icon name={KIND_ICON[node.kind]} />
        <span className="cf-label">{node.label}{node.bases?.length ? <span className="cf-bases">({node.bases.join(', ')})</span> : null}</span>
        {(node.decorators ?? []).map(d => <span key={d} className="cf-chip">@{d.split('(')[0]}</span>)}
        <span className="cf-counts" title={`${childCount} members · ${fields.length} fields`}>
          <Icon name="symbol-method" />{childCount} <Icon name="symbol-field" />{fields.length}
        </span>
        {hasChildren && <CollapseButton id={node.id} collapsed={collapsed} />}
        <ArrowHandle type="source" id="calls" />
      </div>
      {(fields.length > 0 || !container) && (
        <div className="cf-fields" style={{ height: ROW_H }} title={fields.map(f => `${f.name}: ${f.type ?? '?'}${f.default ? ` = ${f.default}` : ''}`).join('\n')}>
          {fields.length
            ? fields.map(f => <span key={f.name}>{f.name}<span style={{ color: typeColor(f.type) }}>{f.type ? `: ${f.type}` : ''}</span></span>)
            : <span className="cf-muted">{firstLine(node.doc) ?? 'no fields'}</span>}
        </div>
      )}
    </>
  );
}

function ModuleBody({ node, hasChildren, collapsed }: CodeNodeData) {
  const rel = node.file ? node.file.replace(/\\/g, '/').split('/').slice(-2).join('/') : '';
  return (
    <div className="cf-header cf-area-header" style={{ height: HEADER_H }}>
      <ArrowHandle type="target" id="in" />
      <Icon name={KIND_ICON.module} />
      <span className="cf-label">{node.module}</span>
      <span className="cf-file">{rel}</span>
      {hasChildren && <CollapseButton id={node.id} collapsed={collapsed} />}
      <ArrowHandle type="source" id="calls" />
    </div>
  );
}

export const CodeNode = memo(function CodeNode({ data, selected }: NodeProps & { data: CodeNodeData }) {
  const { node, hasChildren, collapsed } = data;
  const { glowing } = useNodeState(node.id);
  const intercept = useStore(s => !!s.layout.intercepts?.includes(node.id));
  const paused = useStore(s => s.pauses.find(p => p.node === node.id)?.reason);
  const container = hasChildren && !collapsed;
  const cls = ['cf-node', `cf-${node.kind}`, node.kind === 'lambda' ? 'cf-pill' : '', container ? 'cf-container' : '',
    selected ? 'cf-selected' : '', glowing ? 'cf-glow' : '', paused ? `cf-paused cf-paused-${paused}` : ''].join(' ');
  const Body = node.kind === 'class' ? ClassBody : node.kind === 'module' ? ModuleBody : node.kind === 'lambda' ? LambdaBody : FunctionBody;
  return (
    <div className={cls} key={glowing}>
      {intercept && <span className="cf-bp" title="Intercept: the program pauses here (F9 to remove)" />}
      {paused && <span className="cf-paused-arrow" title={paused === 'intercept' ? 'Paused here — see the Inspector' : 'Follow step'}><Icon name="debug-stackframe" /></span>}
      <Body {...data} />
    </div>
  );
});

const SPECIAL_LABEL: Record<string, string> = { imports: 'Imports', globals: 'Globals', unresolved: 'Unresolved' };

export const SpecialNode = memo(function SpecialNode({ data, selected }: NodeProps & { data: CodeNodeData }) {
  const { node } = data;
  const { glowing } = useNodeState(node.id);
  const open = useStore(s => s.layout.nodes[node.id]?.openGroups);
  const toggleGroup = useStore(s => s.toggleGroup);
  const portRow = (p: Port, label: string) => (
    <div className="cf-row cf-row-sym" key={p.id} style={{ height: ROW_H }} title={p.id}>
      <Handle type="target" position={Position.Left} id={p.id} className="cf-handle cf-shape-circle" style={{ color: typeColor(p.type) }} />
      <span className="cf-port-name">{label}</span>
      <Handle type="source" position={Position.Right} id={p.id} className="cf-handle cf-shape-circle" style={{ color: typeColor(p.type) }} />
    </div>
  );
  return (
    <div className={`cf-node cf-special cf-${node.kind} ${selected ? 'cf-selected' : ''} ${glowing ? 'cf-glow' : ''}`}>
      <div className="cf-header" style={{ height: HEADER_H }}>
        <Icon name={KIND_ICON[node.kind]} />
        <span className="cf-label">{SPECIAL_LABEL[node.kind] ?? node.label}</span>
        <span className="cf-file">{node.ports.length}</span>
      </div>
      {portGroups(node).map(g => {
        if (g.ports.length === 1) return portRow(g.ports[0], g.ports[0].id);
        const isOpen = !!open?.includes(g.key);
        return (
          <div key={g.key}>
            <div className="cf-row cf-group-row nodrag" style={{ height: ROW_H }} onClick={() => toggleGroup(node.id, g.key)}
              title={`${g.ports.length} symbols — click to ${isOpen ? 'merge' : 'show each'}`}>
              {!isOpen && <Handle type="target" position={Position.Left} id={`group:${g.key}`} className="cf-handle cf-shape-grid" />}
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
              <span className="cf-port-name">{g.key}</span>
              <span className="cf-group-count">{g.ports.length}</span>
              {!isOpen && <Handle type="source" position={Position.Right} id={`group:${g.key}`} className="cf-handle cf-shape-grid" />}
            </div>
            {isOpen && g.ports.map(p => portRow(p, p.id.slice(g.key.length + 1) || p.id))}
          </div>
        );
      })}
    </div>
  );
});
