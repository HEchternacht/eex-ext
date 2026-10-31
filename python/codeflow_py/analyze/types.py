"""Types for ports: annotation first, then Jedi inference, else 'unknown'."""
from __future__ import annotations

import ast
from typing import Callable

import jedi

from .symbols import ModuleInfo, Symbol

UNKNOWN = "unknown"


class TypeResolver:
    def __init__(self, project: jedi.Project):
        self.project = project
        self._scripts: dict[str, jedi.Script] = {}
        self._returns: dict[str, str] = {}
        self.symbol_at: Callable[[str, int], Symbol | None] | None = None   # (file, def line) -> project symbol

    def _script(self, mod: ModuleInfo) -> jedi.Script:
        if mod.file not in self._scripts:
            self._scripts[mod.file] = jedi.Script(mod.source, path=mod.file, project=self.project)
        return self._scripts[mod.file]

    def invalidate(self, file: str) -> None:
        self._scripts.pop(file, None)
        self._returns = {k: v for k, v in self._returns.items() if not k.startswith(file + "::")}

    def returns(self, mod: ModuleInfo, sym: Symbol) -> str:
        if sym.returns:
            return sym.returns
        if sym.kind not in ("function", "method", "property"):
            return UNKNOWN
        key = f"{mod.file}::{sym.id}"
        if key not in self._returns:
            self._returns[key] = self._infer_return(mod, sym)
        return self._returns[key]

    def _infer_return(self, mod: ModuleInfo, sym: Symbol) -> str:
        """Union of the types of the function's own `return` expressions."""
        node = sym.ast_node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return UNKNOWN
        returns: list[ast.Return] = []
        generator = False
        stack: list[ast.AST] = list(node.body)
        while stack:
            n = stack.pop()
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            if isinstance(n, ast.Return):
                returns.append(n)
            elif isinstance(n, (ast.Yield, ast.YieldFrom)):
                generator = True
            stack.extend(ast.iter_child_nodes(n))
        if generator:
            return "Generator"
        out: list[str] = []
        for r in returns or [None]:
            for label in self._expr_types(mod, r.value if r else None):
                if label not in out:
                    out.append(label)
        return " | ".join(out[:3]) or UNKNOWN

    def _expr_types(self, mod: ModuleInfo, expr: ast.expr | None) -> list[str]:
        if expr is None:
            return ["None"]
        if isinstance(expr, ast.Constant):
            return ["None" if expr.value is None else type(expr.value).__name__]
        if isinstance(expr, ast.Call) and isinstance(expr.func, (ast.Name, ast.Attribute)):
            annotated = self._callee_annotation(mod, expr.func)
            if annotated:
                return [annotated]
        if expr.end_lineno is None or expr.end_col_offset is None:
            return []
        line = mod.source.splitlines()[expr.end_lineno - 1]
        col = len(line.encode("utf-8")[: expr.end_col_offset].decode("utf-8", "ignore"))
        try:
            names = self._script(mod).infer(expr.end_lineno, col)
        except Exception:
            return []
        return [n.name if n.type in ("instance", "class") else n.type for n in names if n.name]

    def _callee_annotation(self, mod: ModuleInfo, func: ast.Name | ast.Attribute) -> str | None:
        if func.end_lineno is None or func.end_col_offset is None:
            return None
        line = mod.source.splitlines()[func.end_lineno - 1]
        end = len(line.encode("utf-8")[: func.end_col_offset].decode("utf-8", "ignore"))
        name = func.id if isinstance(func, ast.Name) else func.attr
        try:
            targets = self._script(mod).goto(func.end_lineno, end - len(name), follow_imports=True)
        except Exception:
            return None
        for t in targets:
            sym = self.symbol_at(str(t.module_path), t.line) if t.module_path and self.symbol_at else None
            if sym is not None and sym.returns:
                return sym.returns
        return None
