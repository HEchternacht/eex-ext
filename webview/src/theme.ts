// One visual grammar: the same type colour for ports, wires, inspector badges and log values (see UIX_RESEARCH.md 2.4).
import type { NodeKind } from '../../shared/graph';

export type TypeKind = 'int' | 'float' | 'bool' | 'str' | 'bytes' | 'none' | 'list' | 'dict' | 'class' | 'callable'
  | 'coroutine' | 'exception' | 'any';

const NAMES: [RegExp, TypeKind][] = [
  [/^(int|IntEnum|Integral)$/, 'int'],
  [/^(float|Decimal|Real|complex)$/, 'float'],
  [/^bool$/, 'bool'],
  [/^(str|LiteralString|Path|PurePath)$/, 'str'],
  [/^(bytes|bytearray|memoryview)$/, 'bytes'],
  [/^(None|NoneType)$/, 'none'],
  [/^(list|tuple|set|frozenset|deque|List|Tuple|Set|FrozenSet|Sequence|MutableSequence|Iterable|Iterator|Generator|AbstractSet)$/, 'list'],
  [/^(dict|Dict|Mapping|MutableMapping|defaultdict|OrderedDict|Counter|TypedDict)$/, 'dict'],
  [/^(Callable|function|FunctionType|MethodType|partial)$/, 'callable'],
  [/^(Coroutine|CoroutineType|Awaitable|AsyncIterator|AsyncGenerator|Future|Task)$/, 'coroutine'],
  [/(Error|Exception)$/, 'exception'],
  [/^(Any|object|unknown|)$/, 'any'],
];

/** Split `A | B` / `Optional[A]` at the top level; returns the parts without None and whether None was one of them. */
export function unionParts(t: string): { parts: string[]; optional: boolean } {
  let s = t.trim();
  let optional = false;
  const opt = /^(?:typing\.)?Optional\[(.*)\]$/.exec(s);
  if (opt) {
    s = opt[1];
    optional = true;
  }
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === '|' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  const kept = parts.filter(p => p !== 'None');
  return { parts: kept.length ? kept : ['None'], optional: optional || kept.length < parts.length };
}

/** Colour family of an annotation or runtime type name: the outer type of the first non-None union member. */
export function typeKind(t: string | null | undefined): TypeKind {
  if (!t) return 'any';
  const first = unionParts(t).parts[0];
  const outer = first.split('[')[0].trim().split('.').pop()!;
  for (const [re, k] of NAMES) if (re.test(outer)) return k;
  return /^[A-Z_]/.test(outer) ? 'class' : 'any';
}

/** CSS colour of a type family; the variables are defined per colour scheme in styles.css. */
export const typeColor = (t: string | null | undefined) => `var(--cf-type-${typeKind(t)})`;

export const KIND_ICON: Record<NodeKind, string> = {
  module: 'file-code', class: 'symbol-class', function: 'symbol-function', method: 'symbol-method',
  lambda: 'symbol-operator', property: 'symbol-property', decorator: 'symbol-event',
  imports: 'library', globals: 'symbol-variable', unresolved: 'question',
};
