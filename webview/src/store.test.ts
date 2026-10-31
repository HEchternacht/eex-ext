import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({ post: vi.fn() }));
const { useStore } = await import('./store');

describe('packed positions', () => {
  it('a dragged packed node stays where it is dropped; saved positions come back when filters change', () => {
    const st = useStore.getState;
    useStore.setState({ layout: { ...st().layout, nodes: { a: { x: 500, y: 500 }, b: { x: 900, y: 0 } } } });
    st().arrange({ a: { x: 0, y: 0 } });
    st().dragNode('a', 40, 60);
    expect(st().arranged!.a).toEqual({ x: 40, y: 60 });
    expect(st().layout.nodes.a).toEqual({ x: 500, y: 500 });   // the saved layout is untouched
    st().dragNode('b', 10, 10);                                   // not packed: a normal move
    expect(st().layout.nodes.b).toEqual({ x: 10, y: 10 });
    st().setFilters({ pathFilter: 'x' });
    expect(st().arranged).toBe(null);
  });
});
