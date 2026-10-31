import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../../shared/graph';
import { classIndex, expandType, inferType, parseType, showType } from './types';

const cls = (id: string, fields: [string, string | null][]): GraphNode => ({
  id, kind: 'class', label: id.split('.').pop()!, module: 'm', qualname: id, parentId: null, file: null, range: null,
  isAsync: false, ports: [], fields: fields.map(([name, type], line) => ({ name, type, line })),
});

describe('type expander', () => {
  it('parses nested generics, unions, Optional and Annotated', () => {
    expect(showType(parseType('list[list[Optional[int | str]]]'))).toBe('list[list[Optional[int | str]]]');
    expect(showType(parseType('dict[str, app.models.Frame] | None'))).toBe('dict[str, Frame] | None');
    expect(showType(parseType('Annotated[int, Field(gt=0)]'))).toBe('int');
    expect(showType(parseType('tuple[str, ...]'))).toBe('tuple[str, ...]');
    expect(showType(parseType('Callable[[int, str], bool]'))).toBe('Callable[[int, str], bool]');
    expect(parseType('Optional[int]').args[0].name).toBe('int');
  });

  it('expands project classes into fields down to builtins and stops cycles', () => {
    const classes = classIndex([
      cls('m.Frame', [['pixels', 'list[list[Optional[int | str]]]'], ['meta', 'Meta'], ['parent', 'Optional[Frame]']]),
      cls('m.Meta', [['name', 'str'], ['tags', null]]),
    ]);
    const t = expandType(parseType('Frame'), classes);
    expect(t.cls).toBe('m.Frame');
    expect(t.fields!.map(f => [f.name, showType(f.type)])).toEqual([
      ['pixels', 'list[list[Optional[int | str]]]'], ['meta', 'Meta'], ['parent', 'Optional[Frame]'],
    ]);
    expect(t.fields![1].type.fields!.map(f => showType(f.type))).toEqual(['str', 'Any']);
    expect(t.fields![2].type.args[0].cycle).toBe(true);
  });
});

describe('best-guess types from traced values', () => {
  it('infers element unions and object fields', () => {
    const v = { t: 'list', k: 'list' as const, r: '', n: 2, items: [
      { key: 0, v: { t: 'app.Frame', k: 'dataclass' as const, r: '', items: [{ key: 'w', v: { t: 'int', k: 'int' as const, r: '1' } }] } },
      { key: 1, v: { t: 'NoneType', k: 'none' as const, r: 'None' } },
    ] };
    const t = inferType(v);
    expect(showType(t)).toBe('list[Frame | None]');
    expect(t.args[0].args[0].fields!.map(f => [f.name, showType(f.type)])).toEqual([['w', 'int']]);
  });
});
