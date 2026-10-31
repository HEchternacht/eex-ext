"""Pass 2: edges (calls, references, decorators, dependencies, globals) resolved with Jedi."""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import jedi

from .symbols import ModuleInfo, Symbol

IMPORTS = "<imports>"
GLOBALS = "<globals>"
UNRESOLVED = "<unresolved>"

# decorators that only change binding semantics; drawing them is noise
_BINDING_DECORATORS = {"property", "staticmethod", "classmethod", "abstractmethod", "setter",
                       "getter", "deleter", "cached_property", "dataclass", "overload"}
_MAX_DUCK_CANDIDATES = 5
# method names of builtin containers/scalars: an untyped `x.get()` is far more likely a dict than a project class
_BUILTIN_METHODS = {name for t in (dict, list, str, set, tuple, bytes, int, float) for name in dir(t)}


@dataclass
class Target:
    node: str                       # node id (project symbol, IMPORTS, GLOBALS or UNRESOLVED)
    port: str | None = None         # port on special nodes (dotted name / variable / expression)
    resolved: bool = True
    kind_hint: str | None = None    # symbol kind of project target


@dataclass
class RawEdge:
    kind: str                       # call | method_call | reference | decorates | depends | global_read | global_write | flow
    source: str
    target: str
    level: int
    resolved: bool
    line: int
    file: str
    source_port: str | None = None
    target_port: str | None = None
    label: str | None = None
    args: list[dict] = field(default_factory=list)


class Project:
    """Workspace-wide lookup tables shared by every module's edge pass."""

    def __init__(self, root: Path, modules: dict[str, ModuleInfo], is_project_file: Callable[[str], bool]):
        self.root = root
        self.modules = modules
        self.is_project_file = is_project_file
        self.jedi_project = jedi.Project(str(root))
        self.by_def: dict[tuple[str, int], Symbol] = {}
        self.by_file: dict[str, ModuleInfo] = {}
        self.methods_by_name: dict[str, list[Symbol]] = {}
        self.global_names: set[str] = set()
        self.property_names: set[str] = set()
        for m in modules.values():
            self.by_file[_norm(m.file)] = m
            self.global_names |= set(m.globals)
            for s in m.symbols.values():
                if s.kind != "module":
                    self.by_def[(_norm(s.file), s.def_line)] = s
                if s.kind in ("method", "property"):
                    self.methods_by_name.setdefault(s.qualname.rsplit(".", 1)[-1], []).append(s)
                if s.kind == "property":
                    self.property_names.add(s.qualname.rsplit(".", 1)[-1])


def _norm(path: str | Path) -> str:
    return str(Path(path).resolve()).lower()


def _level(kind: str | None) -> int:
    return 2 if kind in ("function", "lambda", None) else 3


class _ScopeWalker:
    """Walks one scope's own statements; nested defs/lambdas/classes are separate scopes."""

    def __init__(self, analyzer: "ModuleEdges", scope: Symbol):
        self.a = analyzer
        self.scope = scope
        self.declared_global: set[str] = set()
        self.locals: set[str] = set()

    def run(self) -> None:
        node = self.scope.ast_node
        if isinstance(node, ast.Module):
            body: list[ast.AST] = list(node.body)
        elif isinstance(node, ast.Lambda):
            body = [node.body]
            self.locals = {p.name.lstrip("*") for p in self.scope.params}
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            body = list(node.body)
            self.locals = {a.arg for a in ast.walk(node.args) if isinstance(a, ast.arg)}
            for n in self._own_nodes(body):
                if isinstance(n, ast.Global):
                    self.declared_global |= set(n.names)
                elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                    self.locals.add(n.id)
            self.locals -= self.declared_global
        else:
            return
        call_funcs: set[int] = set()
        for n in self._own_nodes(body):
            if isinstance(n, ast.Call):
                call_funcs.add(id(n.func))
                self.a.call(self.scope, n)
        for n in self._own_nodes(body):
            if isinstance(n, (ast.Name, ast.Attribute)) and id(n) not in call_funcs:
                self._name_use(n)
            elif isinstance(n, ast.Subscript) and isinstance(n.ctx, ast.Store):
                self.a.subscript_store(self.scope, n)  # item assignment on a global: cache["k"] = v

    def _own_nodes(self, body: list[ast.AST]):
        stack: list[ast.AST] = []
        self._push(stack, body)
        while stack:
            n = stack.pop()
            yield n
            self._push(stack, list(ast.iter_child_nodes(n)))

    @staticmethod
    def _push(stack: list[ast.AST], nodes: list[ast.AST]) -> None:
        for child in reversed(nodes):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                # decorators / defaults / bases belong to this scope; bodies do not
                stack.extend(child.decorator_list)
                if isinstance(child, ast.ClassDef):
                    stack.extend(child.bases)
                else:
                    stack.extend(child.args.defaults)
                    stack.extend(d for d in child.args.kw_defaults if d)
            elif isinstance(child, ast.Lambda):
                stack.extend(child.args.defaults)
            else:
                stack.append(child)

    def _name_use(self, n: ast.Name | ast.Attribute) -> None:
        a = self.a
        if isinstance(n, ast.Name):
            if n.id in self.locals and n.id not in self.declared_global:
                if isinstance(n.ctx, ast.Load):
                    return
            if isinstance(n.ctx, ast.Store):
                if self.scope.kind == "module" or n.id in self.declared_global:
                    a.global_edge(self.scope, a.module.name, n.id, write=True, line=n.lineno)
                return
            if isinstance(n.ctx, ast.Load):
                a.load(self.scope, n)
            return
        # Attribute
        if isinstance(n.ctx, ast.Load):
            if n.attr in a.project.methods_by_name or n.attr in a.project.global_names:
                a.load(self.scope, n)
        elif isinstance(n.value, ast.Name) and n.value.id not in self.locals:
            # module_global.attr = x  → write to that global
            a.load(self.scope, n.value, write=True)


Producers = set[tuple[str, tuple[str, ...]]]   # (project node whose return value it is, library calls it went through)


class _FlowWalker:
    """Data flow inside one scope: a project function's return value reaching another's argument is a flow edge.
    Library / unresolved calls pass their inputs (arguments and receiver) through; their names label the wire."""

    def __init__(self, analyzer: "ModuleEdges", scope: Symbol):
        self.a = analyzer
        self.scope = scope
        self.env: dict[str, Producers] = {}

    def run(self) -> None:
        node = self.scope.ast_node
        if isinstance(node, ast.Lambda):
            self.value(node.body)
        elif isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)):
            for st in node.body:
                self.visit(st)

    def visit(self, n: ast.AST) -> None:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return   # own scope
        if isinstance(n, ast.expr):
            self.value(n)
        elif isinstance(n, ast.Assign):
            v = self.value(n.value)
            for t in n.targets:
                self.bind(t, v)
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)) and n.value is not None:
            v = self.value(n.value)
            self.bind(n.target, v | self.value(n.target) if isinstance(n, ast.AugAssign) else v)
        elif isinstance(n, (ast.For, ast.AsyncFor)):
            self.bind(n.target, self.value(n.iter))
            for st in n.body + n.orelse:
                self.visit(st)
        elif isinstance(n, (ast.With, ast.AsyncWith)):
            for item in n.items:
                v = self.value(item.context_expr)
                if item.optional_vars is not None:
                    self.bind(item.optional_vars, v)
            for st in n.body:
                self.visit(st)
        else:
            for child in ast.iter_child_nodes(n):
                self.visit(child)

    def bind(self, target: ast.AST, v: Producers) -> None:
        if isinstance(target, ast.Name):
            self.env[target.id] = set(v)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self.bind(elt, v)
        elif isinstance(target, ast.Starred):
            self.bind(target.value, v)

    def value(self, e: ast.expr) -> Producers:
        if isinstance(e, ast.Name):
            return set(self.env.get(e.id, ()))
        if isinstance(e, ast.Call):
            return self.call(e)
        if isinstance(e, ast.NamedExpr):
            v = self.value(e.value)
            self.bind(e.target, v)
            return v
        if isinstance(e, ast.Lambda):
            return set()
        if isinstance(e, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            for g in e.generators:
                self.bind(g.target, self.value(g.iter))
                for cond in g.ifs:
                    self.value(cond)
            parts = [e.key, e.value] if isinstance(e, ast.DictComp) else [e.elt]
            return set().union(*(self.value(p) for p in parts))
        out: Producers = set()
        for child in ast.iter_child_nodes(e):
            if isinstance(child, ast.expr):
                out |= self.value(child)
        return out

    def call(self, c: ast.Call) -> Producers:
        func = c.func
        receiver = self.value(func.value) if isinstance(func, ast.Attribute) else self.value(func) if isinstance(func, ast.Call) else set()
        args = [self.value(a) for a in c.args]
        kwargs = [(k.arg, self.value(k.value)) for k in c.keywords]
        sym, ctor, label = self.a.flow_target(func)
        if sym is None:   # library / unresolved: the result carries its inputs, plus this step's name
            out: Producers = set()
            for node, via in receiver.union(*args, *(v for _, v in kwargs)):
                out.add((node, via if via[-1:] == (label,) or len(via) >= 3 else via + (label,)))
            return out
        names = [p.name for p in sym.params]
        star = next((n for n in names if n.startswith("*") and not n.startswith("**")), None)
        dstar = next((n for n in names if n.startswith("**")), None)
        plain = [n for n in names if not n.startswith("*")]
        for i, (a, v) in enumerate(zip(c.args, args)):
            if isinstance(a, ast.Starred):
                break
            self._emit(v, sym, plain[i] if i < len(plain) else star, c.lineno)
        for k, v in kwargs:
            self._emit(v, sym, k if k in plain else dstar if k else None, c.lineno)
        return set() if ctor else {(sym.id, ())}

    def _emit(self, producers: Producers, sym: Symbol, param: str | None, line: int) -> None:
        if param is None:
            return
        for node, via in producers:
            if node != sym.id:
                self.a._add(kind="flow", source=node, target=sym.id, target_port=f"arg:{param}", level=1,
                            resolved=True, line=line, label=f"via {', '.join(via)}" if via else None)


class ModuleEdges:
    def __init__(self, project: Project, module: ModuleInfo):
        self.project = project
        self.module = module
        self.script = jedi.Script(module.source, path=module.file, project=project.jedi_project)
        self.lines = module.source.splitlines()
        self.edges: list[RawEdge] = []
        self._cache: dict[tuple[int, int], list] = {}

    # ---- jedi helpers -------------------------------------------------
    def _col(self, line: int, byte_col: int) -> int:
        text = self.lines[line - 1] if 0 < line <= len(self.lines) else ""
        return len(text.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))

    def _pos(self, expr: ast.expr) -> tuple[int, int] | None:
        if isinstance(expr, ast.Name):
            return expr.lineno, self._col(expr.lineno, expr.col_offset)
        if isinstance(expr, ast.Attribute) and expr.end_lineno and expr.end_col_offset is not None:
            line = expr.end_lineno
            return line, self._col(line, expr.end_col_offset) - len(expr.attr)
        return None

    def _goto(self, expr: ast.expr) -> list:
        pos = self._pos(expr)
        if pos is None:
            return []
        if pos not in self._cache:
            try:
                self._cache[pos] = self.script.goto(*pos, follow_imports=True)
            except Exception:
                self._cache[pos] = []
        return self._cache[pos]

    def infer_type(self, expr: ast.expr) -> str | None:
        if isinstance(expr, ast.Constant):
            return type(expr.value).__name__
        if isinstance(expr, (ast.List, ast.ListComp)):
            return "list"
        if isinstance(expr, (ast.Dict, ast.DictComp)):
            return "dict"
        if isinstance(expr, (ast.Tuple,)):
            return "tuple"
        if isinstance(expr, (ast.JoinedStr,)):
            return "str"
        pos = self._pos(expr)
        if pos is None:
            return None
        try:
            names = self.script.infer(*pos)
        except Exception:
            return None
        return _type_names(names)

    # ---- classification -----------------------------------------------
    def classify(self, expr: ast.expr) -> list[Target]:
        names = self._goto(expr)
        out: list[Target] = []
        for n in names:
            t = self._target_for(n)
            if t and all(t.node != o.node or t.port != o.port for o in out):
                out.append(t)
        return out

    def _target_for(self, n) -> Target | None:
        path = n.module_path
        if path is None or not self.project.is_project_file(str(path)):
            if n.type == "param":
                return None
            return Target(IMPORTS, port=n.full_name or n.name)
        mod = self.project.by_file.get(_norm(path))
        if mod is None:
            return None
        if n.type in ("function", "class"):
            sym = self.project.by_def.get((_norm(path), n.line))
            if sym is not None:
                return Target(sym.id, kind_hint=sym.kind)
            return None
        if n.type == "property":
            sym = self.project.by_def.get((_norm(path), n.line))
            return Target(sym.id, kind_hint="property") if sym else None
        if n.type == "statement":
            parent = n.parent()
            if parent is not None and parent.type == "module" and n.name in mod.globals:
                return Target(GLOBALS, port=f"{mod.name}.{n.name}")
        if n.type == "module":
            return None
        return None

    def flow_target(self, func: ast.expr) -> tuple[Symbol | None, bool, str]:
        """(project function called, is a class constructor, label when it is not a project function)."""
        targets = self.classify(func) if isinstance(func, (ast.Name, ast.Attribute)) else []
        for t in targets:
            if t.node in (IMPORTS, GLOBALS, UNRESOLVED):
                continue
            symbols = self.project.modules[self._module_of(t.node)].symbols
            if t.kind_hint == "class":
                init = symbols.get(t.node + ".__init__")
                return (init, True, "") if init else (None, False, t.node.rsplit(".", 1)[-1])
            if t.node in symbols:
                return symbols[t.node], False, ""
        ext = next((t.port for t in targets if t.node == IMPORTS and t.port), None)
        return None, False, ".".join(ext.removeprefix("builtins.").split(".")[-2:]) if ext else _short(ast.unparse(func), 30)

    # ---- edges --------------------------------------------------------
    def _add(self, **kw) -> None:
        self.edges.append(RawEdge(file=self.module.file, **kw))

    def call(self, scope: Symbol, call: ast.Call) -> None:
        func = call.func
        if isinstance(func, ast.Call):
            return  # f(x)(y): inner call recorded; the returned callable is dynamic
        label = _short(ast.unparse(func))
        targets = self.classify(func) if isinstance(func, (ast.Name, ast.Attribute)) else []
        args = [{"expr": _short(ast.unparse(a)), "type": self.infer_type(a)} for a in call.args]
        args += [{"expr": f"{k.arg}={_short(ast.unparse(k.value))}", "type": self.infer_type(k.value)}
                 for k in call.keywords]
        project = [t for t in targets if t.node not in (IMPORTS, GLOBALS)]
        if project:
            for t in project:
                kind_hint = t.kind_hint
                if kind_hint == "class":
                    init = self.project.modules[self._module_of(t.node)].symbols.get(t.node + ".__init__")
                    if init is not None:
                        t = Target(init.id, kind_hint="method")
                kind = "call" if t.kind_hint in ("function", "lambda") else "method_call"
                self._add(kind=kind, source=scope.id, target=t.node, level=_level(t.kind_hint),
                          resolved=t.resolved, line=call.lineno, label=label, args=args)
            return
        ext = [t for t in targets if t.node == IMPORTS]
        if ext:
            self._add(kind="call", source=scope.id, target=IMPORTS, target_port=ext[0].port,
                      level=3 if isinstance(func, ast.Attribute) else 2, resolved=True,
                      line=call.lineno, label=label, args=args)
            return
        glob = [t for t in targets if t.node == GLOBALS]
        if glob:
            # calling a value stored in a global (e.g. HANDLERS[...]) - target is dynamic
            self._add(kind="global_read", source=GLOBALS, source_port=glob[0].port, target=scope.id,
                      level=3, resolved=True, line=call.lineno, label=glob[0].port.rsplit(".", 1)[-1])
        self._unresolved_call(scope, call, label, args)

    def _unresolved_call(self, scope: Symbol, call: ast.Call, label: str, args: list[dict]) -> None:
        func = call.func
        if isinstance(func, ast.Subscript):
            base = func.value
            if isinstance(base, (ast.Name, ast.Attribute)):
                for t in self.classify(base):
                    if t.node == GLOBALS:
                        self._add(kind="global_read", source=GLOBALS, source_port=t.port, target=scope.id,
                                  level=3, resolved=True, line=call.lineno, label=t.port.rsplit(".", 1)[-1])
        if isinstance(func, ast.Attribute):
            candidates = [] if func.attr in _BUILTIN_METHODS else self.project.methods_by_name.get(func.attr, [])
            if 0 < len(candidates) <= _MAX_DUCK_CANDIDATES:
                for c in candidates:
                    self._add(kind="method_call", source=scope.id, target=c.id, level=3, resolved=False,
                              line=call.lineno, label=label, args=args)
                return
        self._add(kind="call", source=scope.id, target=UNRESOLVED, target_port=label, level=3,
                  resolved=False, line=call.lineno, label=label, args=args)

    def load(self, scope: Symbol, expr: ast.Name | ast.Attribute, write: bool = False) -> None:
        for t in self.classify(expr):
            if t.node == GLOBALS:
                mod, var = t.port.rsplit(".", 1)
                self.global_edge(scope, mod, var, write=write, line=expr.lineno)
            elif t.node in (IMPORTS, UNRESOLVED) or write:
                continue
            elif t.kind_hint == "property":
                self._add(kind="method_call", source=scope.id, target=t.node, level=3, resolved=True,
                          line=expr.lineno, label=_short(ast.unparse(expr)))
            elif t.kind_hint in ("function", "method", "lambda") and t.node != scope.id:
                # function passed as a value (callback, dispatch table entry)
                self._add(kind="reference", source=scope.id, target=t.node, level=_level(t.kind_hint),
                          resolved=True, line=expr.lineno, label=_short(ast.unparse(expr)))

    def global_edge(self, scope: Symbol, module: str, var: str, write: bool, line: int) -> None:
        mod = self.project.modules.get(module)
        if mod is None or var not in mod.globals or var in mod.aliases:
            return
        port = f"{module}.{var}"
        if write:
            self._add(kind="global_write", source=scope.id, target=GLOBALS, target_port=port, level=3,
                      resolved=True, line=line, label=var)
        else:
            self._add(kind="global_read", source=GLOBALS, source_port=port, target=scope.id, level=3,
                      resolved=True, line=line, label=var)

    def subscript_store(self, scope: Symbol, node: ast.Subscript) -> None:
        base = node.value
        if isinstance(base, (ast.Name, ast.Attribute)):
            self.load(scope, base, write=True)

    def decorators(self, sym: Symbol) -> None:
        for d in sym.decorators:
            target_expr = d.func if isinstance(d, ast.Call) else d
            name = ast.unparse(target_expr).split(".")[-1]
            if name in _BINDING_DECORATORS:
                continue
            label = _short(ast.unparse(d))
            if not isinstance(target_expr, (ast.Name, ast.Attribute)):
                continue
            targets = self.classify(target_expr)
            if not targets and isinstance(target_expr, ast.Attribute):
                targets = [t for t in self.classify(target_expr.value) if t.node == GLOBALS]
            if not targets:
                self._add(kind="decorates", source=UNRESOLVED, source_port=label, target=sym.id, level=2,
                          resolved=False, line=d.lineno, label=label)
            if isinstance(target_expr, ast.Attribute) and isinstance(target_expr.value, (ast.Name, ast.Attribute)):
                # @router.get(...): the object owning the decorator (a global) flows into the function
                self.load(sym, target_expr.value)
            for t in targets[:1]:
                self._add(kind="decorates", source=t.node, source_port=t.port, target=sym.id,
                          level=_level(t.kind_hint) if t.node not in (IMPORTS, GLOBALS) else 3,
                          resolved=t.resolved, line=d.lineno, label=label)

    def dependencies(self, sym: Symbol) -> None:
        """Callables referenced inside a parameter's default/annotation feed that parameter."""
        for p in sym.params:
            exprs = [e for e in (p.default,) if e is not None]
            node = sym.ast_node
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                    if a.arg == p.name and a.annotation is not None:
                        exprs.append(a.annotation)
            for e in exprs:
                for wrapper, ref in self._callable_refs(e):
                    self._depends(sym, p.name, wrapper, ref)

    def _callable_refs(self, expr: ast.expr):
        for n in ast.walk(expr):
            if isinstance(n, ast.Call):
                wrapper = _short(ast.unparse(n.func))
                for arg in list(n.args) + [k.value for k in n.keywords]:
                    if isinstance(arg, (ast.Name, ast.Attribute)):
                        yield wrapper, arg
            elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                # annotation alias defined at module level, e.g. SettingsDep = Annotated[S, Depends(f)]
                for t in self.classify(n):
                    if t.node == GLOBALS:
                        yield from self._alias_refs(t.port)

    def _alias_refs(self, port: str):
        mod_name, var = port.rsplit(".", 1)
        mod = self.project.modules.get(mod_name)
        if mod is None:
            return
        for stmt in mod.tree.body:
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
            if any(isinstance(t, ast.Name) and t.id == var for t in targets) and stmt.value is not None:
                other = ModuleEdges.for_module(self.project, mod)
                for n in ast.walk(stmt.value):
                    if isinstance(n, ast.Call):
                        wrapper = _short(ast.unparse(n.func))
                        for arg in list(n.args) + [k.value for k in n.keywords]:
                            if isinstance(arg, (ast.Name, ast.Attribute)):
                                yield wrapper, _Foreign(other, arg)

    def _depends(self, sym: Symbol, param: str, wrapper: str, ref) -> None:
        owner, expr = (ref.edges, ref.expr) if isinstance(ref, _Foreign) else (self, ref)
        for t in owner.classify(expr):
            if t.node in (IMPORTS, GLOBALS, UNRESOLVED):
                continue
            self._add(kind="depends", source=sym.id, target=t.node, level=2, resolved=True,
                      line=sym.def_line, label=wrapper, source_port=f"arg:{param}")

    def _module_of(self, node_id: str) -> str:
        best = ""
        for m in self.project.modules:
            if (node_id == m or node_id.startswith(m + ".")) and len(m) > len(best):
                best = m
        return best

    _instances: dict[tuple[int, str], "ModuleEdges"] = {}

    @classmethod
    def for_module(cls, project: Project, mod: ModuleInfo) -> "ModuleEdges":
        key = (id(project), mod.name)
        if key not in cls._instances:
            cls._instances[key] = ModuleEdges(project, mod)
        return cls._instances[key]

    def run(self) -> list[RawEdge]:
        for sym in self.module.symbols.values():
            _ScopeWalker(self, sym).run()
            if sym.kind in ("function", "method", "property", "class"):
                self.decorators(sym)
            if sym.kind in ("function", "method", "property"):
                self.dependencies(sym)
            _FlowWalker(self, sym).run()
        return self.edges


@dataclass
class _Foreign:
    edges: ModuleEdges
    expr: ast.expr


def _short(text: str, limit: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _type_names(names) -> str | None:
    out: list[str] = []
    for n in names:
        if n.type == "instance" or n.type == "class":
            label = n.name
        elif n.type == "function":
            label = "Callable"
        elif n.type == "module":
            label = "module"
        else:
            label = n.name
        if label and label not in out:
            out.append(label)
    return " | ".join(out[:3]) if out else None
