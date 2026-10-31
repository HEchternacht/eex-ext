"""Pass 1: ast symbol table (modules, classes, functions, lambdas, globals)."""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Param:
    name: str
    annotation: str | None
    default: ast.expr | None = None


@dataclass
class Symbol:
    id: str                      # module.qualname
    kind: str                    # module | class | function | method | lambda | property
    module: str
    qualname: str
    file: str
    start: int                   # first line (decorators included)
    end: int
    def_line: int                # line of `def` / `class` / `lambda`
    parent: str | None
    ast_node: ast.AST | None = None
    params: list[Param] = field(default_factory=list)
    returns: str | None = None
    is_async: bool = False
    decorators: list[ast.expr] = field(default_factory=list)


@dataclass
class ModuleInfo:
    name: str
    file: str
    tree: ast.Module
    source: str
    symbols: dict[str, Symbol]                  # id -> Symbol
    globals: dict[str, int]                     # var name -> line of first module-level assignment
    exported: set[str]                          # names re-exported (package __init__)
    aliases: set[str] = field(default_factory=set)  # type aliases (X = Callable[...]): not drawn as globals


def module_name(root: Path, file: Path) -> str:
    rel = file.relative_to(root).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or rel.stem


def _unparse(node: ast.AST | None) -> str | None:
    return ast.unparse(node) if node is not None else None


def _params(args: ast.arguments, skip_self: bool) -> list[Param]:
    positional = args.posonlyargs + args.args
    defaults: list[ast.expr | None] = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    out = [Param(a.arg, _unparse(a.annotation), d) for a, d in zip(positional, defaults)]
    if args.vararg:
        out.append(Param("*" + args.vararg.arg, _unparse(args.vararg.annotation)))
    out += [Param(a.arg, _unparse(a.annotation), d) for a, d in zip(args.kwonlyargs, args.kw_defaults)]
    if args.kwarg:
        out.append(Param("**" + args.kwarg.arg, _unparse(args.kwarg.annotation)))
    if skip_self and out and out[0].name in ("self", "cls"):
        out = out[1:]
    return out


def _decorator_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    names = set()
    for d in fn.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        names.add(ast.unparse(target).split(".")[-1])
    return names


class _Collector(ast.NodeVisitor):
    def __init__(self, module: str, file: str):
        self.module = module
        self.file = file
        self.symbols: dict[str, Symbol] = {}
        self.globals: dict[str, int] = {}
        self.aliases: set[str] = set()
        self.stack: list[Symbol] = []       # enclosing class/function symbols
        self.lambda_count: dict[tuple[str, int], int] = {}

    def _qual(self, name: str) -> str:
        return ".".join([s.qualname for s in self.stack[-1:]] + [name]) if self.stack else name

    def _parent(self) -> str:
        return self.stack[-1].id if self.stack else self.module

    def _add(self, sym: Symbol) -> None:
        self.symbols[sym.id] = sym

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qual = self._qual(node.name)
        start = min([d.lineno for d in node.decorator_list] + [node.lineno])
        sym = Symbol(f"{self.module}.{qual}", "class", self.module, qual, self.file, start,
                     node.end_lineno or node.lineno, node.lineno, self._parent(), node,
                     decorators=list(node.decorator_list))
        self._add(sym)
        self.stack.append(sym)
        self.generic_visit(node)
        self.stack.pop()

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        in_class = bool(self.stack) and self.stack[-1].kind == "class"
        qual = self._qual(node.name)
        decos = _decorator_names(node)
        if in_class:
            kind = "property" if "property" in decos or "cached_property" in decos else "method"
        else:
            kind = "function"
        start = min([d.lineno for d in node.decorator_list] + [node.lineno])
        sym = Symbol(f"{self.module}.{qual}", kind, self.module, qual, self.file, start,
                     node.end_lineno or node.lineno, node.lineno, self._parent(), node,
                     _params(node.args, in_class and "staticmethod" not in decos),
                     _unparse(node.returns), isinstance(node, ast.AsyncFunctionDef),
                     list(node.decorator_list))
        self._add(sym)
        # decorators and defaults are evaluated in the enclosing scope
        for d in node.decorator_list:
            self.visit(d)
        for d in node.args.defaults + [d for d in node.args.kw_defaults if d]:
            self.visit(d)
        self.stack.append(sym)
        for stmt in node.body:
            self.visit(stmt)
        self.stack.pop()

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    def visit_Lambda(self, node: ast.Lambda) -> None:
        key = (self._parent(), node.lineno)
        n = self.lambda_count.get(key, 0)
        self.lambda_count[key] = n + 1
        name = f"<lambda@L{node.lineno}" + (f"#{n + 1}" if n else "") + ">"
        qual = self._qual(name)
        sym = Symbol(f"{self.module}.{qual}", "lambda", self.module, qual, self.file, node.lineno,
                     node.end_lineno or node.lineno, node.lineno, self._parent(), node,
                     _params(node.args, False))
        self._add(sym)
        self.stack.append(sym)
        self.visit(node.body)
        self.stack.pop()

    def _module_target(self, target: ast.expr, line: int) -> None:
        for t in ast.walk(target):
            if isinstance(t, ast.Name):
                self.globals.setdefault(t.id, line)

    def visit_Assign(self, node: ast.Assign) -> None:
        if not self.stack:
            for t in node.targets:
                self._module_target(t, node.lineno)
                if isinstance(t, ast.Name) and (_is_type_alias(node.value) or t.id.startswith("__")):
                    self.aliases.add(t.id)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if not self.stack and node.value is not None:
            self._module_target(node.target, node.lineno)
            if isinstance(node.target, ast.Name) and ast.unparse(node.annotation).endswith("TypeAlias"):
                self.aliases.add(node.target.id)
        self.generic_visit(node)

    def visit_TypeAlias(self, node) -> None:  # PEP 695 `type X = ...`
        if not self.stack:
            self.aliases.add(node.name.id)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if not self.stack:
            self._module_target(node.target, node.lineno)
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global) -> None:
        for name in node.names:
            self.globals.setdefault(name, node.lineno)


_TYPING_FORMS = {"Callable", "Union", "Optional", "Annotated", "Literal", "Awaitable", "Coroutine", "Iterator",
                 "Iterable", "Mapping", "Sequence", "Type", "type", "dict", "list", "tuple", "set", "frozenset"}


def _is_type_alias(value: ast.expr) -> bool:
    if isinstance(value, ast.Subscript):
        base = ast.unparse(value.value).rsplit(".", 1)[-1]
        return base in _TYPING_FORMS
    if isinstance(value, ast.Call):
        return ast.unparse(value.func).rsplit(".", 1)[-1] in ("TypeVar", "ParamSpec", "TypeVarTuple", "NewType")
    return False


def _exports(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.ImportFrom):
            names |= {a.asname or a.name for a in stmt.names}
    return names


def collect(root: Path, file: Path, source: str | None = None) -> ModuleInfo:
    source = source if source is not None else file.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(file))
    name = module_name(root, file)
    c = _Collector(name, str(file))
    lines = source.count("\n") + 1
    c.symbols[name] = Symbol(name, "module", name, "", str(file), 1, lines, 1, None, tree)
    c.visit(tree)
    # type aliases (X = Callable[...]) are module assignments too; keep them, they're harmless
    exported = _exports(tree) if file.name == "__init__.py" else set()
    return ModuleInfo(name, str(file), tree, source, c.symbols, c.globals, exported, c.aliases)


_DOC_MAX = 2000


def describe(s: Symbol) -> dict:
    """Readable extras for a node: docstring, signature, decorator labels; bases and fields for classes."""
    node = s.ast_node
    out: dict = {}
    if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
        doc = ast.get_docstring(node)
        if doc:
            out["doc"] = doc[:_DOC_MAX]
    if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.decorator_list:
        out["decorators"] = [ast.unparse(d) for d in node.decorator_list]
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        ret = f" -> {ast.unparse(node.returns)}" if node.returns else ""
        out["signature"] = f"{'async ' if s.is_async else ''}def {node.name}({ast.unparse(node.args)}){ret}"
    elif isinstance(node, ast.Lambda):
        text = ast.unparse(node)
        out["signature"] = text if len(text) <= 80 else text[:79] + "…"
    elif isinstance(node, ast.ClassDef):
        bases = [ast.unparse(b) for b in node.bases + node.keywords]
        out["bases"] = bases
        out["signature"] = f"class {node.name}" + (f"({', '.join(bases)})" if bases else "")
        out["fields"] = _fields(node)
    return out


def _fields(cls: ast.ClassDef) -> list[dict]:
    """Class-level names (annotated fields, enum members, class constants) and `self.x` set in __init__."""
    fields: dict[str, dict] = {}

    def add(name: str, annotation: ast.expr | None, value: ast.expr | None, line: int) -> None:
        if name.startswith("__") or (name in fields and fields[name]["type"]):
            return
        f = {"name": name, "type": _unparse(annotation), "line": line}
        if value is not None:
            f["default"] = ast.unparse(value)[:80]
        fields[name] = f

    for stmt in cls.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            add(stmt.target.id, stmt.annotation, stmt.value, stmt.lineno)
        elif isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name):
                    add(t.id, None, stmt.value, stmt.lineno)
    init = next((s for s in cls.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == "__init__"), None)
    if init:
        for n in ast.walk(init):
            target, ann, value = None, None, None
            if isinstance(n, ast.AnnAssign):
                target, ann, value = n.target, n.annotation, n.value
            elif isinstance(n, ast.Assign) and len(n.targets) == 1:
                target, value = n.targets[0], n.value
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self":
                if ann is None and isinstance(value, ast.Name):   # self.x = x: take the parameter's annotation
                    ann = next((a.annotation for a in init.args.args + init.args.kwonlyargs if a.arg == value.id), None)
                add(target.attr, ann, value, n.lineno)
    return list(fields.values())
