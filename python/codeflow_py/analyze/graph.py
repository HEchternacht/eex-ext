"""Assemble the Graph JSON (nodes, ports, merged edges, nesting) and incremental patches."""
from __future__ import annotations

import ast
import fnmatch
import os
from pathlib import Path

from .calls import GLOBALS, IMPORTS, UNRESOLVED, ModuleEdges, Project, RawEdge, _norm
from .symbols import ModuleInfo, collect, describe
from .types import UNKNOWN, TypeResolver

SPECIAL = {IMPORTS: "Imports", GLOBALS: "Globals", UNRESOLVED: "Unresolved"}
NESTABLE = ("function", "lambda", "property", "method")
_INVOKE = ("call", "method_call", "reference", "decorates", "depends")


class Analyzer:
    def __init__(self, root: str, exclude: list[str] | None = None, nest_single_use: bool = True):
        self.root = Path(root).resolve()
        self.exclude = exclude or []
        self.nest_single_use = nest_single_use
        self.modules: dict[str, ModuleInfo] = {}
        self.raw: dict[str, list[RawEdge]] = {}       # module name -> edges
        self.graph: dict = {"nodes": [], "edges": []}
        self.errors: dict[str, str] = {}
        self._types: TypeResolver | None = None

    # ---- files ----------------------------------------------------------
    def _excluded(self, path: Path) -> bool:
        rel = "/" + path.relative_to(self.root).as_posix()
        return any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel + "/", pat) for pat in self.exclude)

    def is_project_file(self, path: str) -> bool:
        p = Path(path).resolve()
        try:
            p.relative_to(self.root)
        except ValueError:
            return False
        return p.suffix in (".py", ".pyi") and not self._excluded(p)

    def files(self) -> list[Path]:
        out = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            d = Path(dirpath)
            dirnames[:] = [n for n in dirnames if not n.startswith(".") and not self._excluded(d / n)]
            out += [d / f for f in filenames if f.endswith(".py") and not self._excluded(d / f)]
        return sorted(out)

    # ---- analysis -------------------------------------------------------
    def _collect(self, file: Path) -> None:
        try:
            info = collect(self.root, file)
        except (SyntaxError, UnicodeDecodeError, OSError) as exc:
            self.errors[str(file)] = str(exc)
            return
        self.errors.pop(str(file), None)
        self.modules[info.name] = info

    def _edges(self, names: set[str]) -> None:
        project = Project(self.root, self.modules, self.is_project_file)
        ModuleEdges._instances.clear()
        if self._types is None:
            self._types = TypeResolver(project.jedi_project)
        self._types.symbol_at = lambda file, line: project.by_def.get((_norm(file), line))
        for name in names:
            mod = self.modules.get(name)
            if mod is not None:
                self.raw[name] = ModuleEdges.for_module(project, mod).run()

    def analyze(self) -> dict:
        self.modules.clear()
        self.raw.clear()
        for f in self.files():
            self._collect(f)
        self._edges(set(self.modules))
        self.graph = self._assemble()
        return self.graph

    def update(self, files: list[str]) -> dict:
        """Re-analyse changed files and their dependents; return a GraphPatch."""
        changed: set[str] = set()
        for f in files:
            p = Path(f).resolve()
            for name, mod in list(self.modules.items()):
                if _norm(mod.file) == _norm(p):
                    del self.modules[name]
                    self.raw.pop(name, None)
                    changed.add(name)
            if self._types:
                self._types.invalidate(str(p))
            if p.exists() and self.is_project_file(str(p)):
                before = set(self.modules)
                self._collect(p)
                changed |= set(self.modules) - before
        dependents = {m for m, edges in self.raw.items()
                      if any(_touches(e, changed) for e in edges)}
        dependents |= {m for m, mod in self.modules.items()
                       if any(c.rsplit(".", 1)[-1] in mod.source for c in changed)}
        self._edges(changed | dependents)
        old = self.graph
        self.graph = self._assemble()
        return diff(old, self.graph)

    # ---- assembly -------------------------------------------------------
    def _assemble(self) -> dict:
        symbols = {s.id: (m, s) for m in self.modules.values() for s in m.symbols.values()}
        raw = [e for edges in self.raw.values() for e in edges]
        decorators = {e.source for e in raw if e.kind == "decorates"}
        nodes: dict[str, dict] = {}
        for sid, (mod, s) in symbols.items():
            node = {
                "id": sid, "kind": "decorator" if sid in decorators and s.kind == "function" else s.kind,
                "label": s.qualname.rsplit(".", 1)[-1] if s.qualname else s.module,
                "module": s.module, "qualname": s.qualname, "parentId": s.parent,
                "file": s.file, "range": {"start": s.start, "end": s.end, "def": s.def_line},
                "isAsync": s.is_async, "ports": [], **describe(s),
            }
            if any(ast.unparse(d).endswith("abstractmethod") for d in s.decorators):
                node["abstract"] = True
            if s.kind in ("function", "method", "property", "lambda"):
                node["ports"] = (
                    [{"id": "in", "name": "in", "dir": "in", "role": "call", "type": None}]
                    + [{"id": f"arg:{p.name}", "name": p.name, "dir": "in", "role": "arg",
                        "type": p.annotation or UNKNOWN,
                        **({"default": ast.unparse(p.default)[:40]} if p.default is not None else {})} for p in s.params]
                    + [{"id": "return", "name": "return", "dir": "out", "role": "return",
                        "type": self._types.returns(mod, s) if self._types else UNKNOWN},
                       {"id": "calls", "name": "calls", "dir": "out", "role": "calls", "type": None}]
                )
            elif s.kind in ("module", "class"):
                node["ports"] = [{"id": "in", "name": "in", "dir": "in", "role": "call", "type": None},
                                 {"id": "calls", "name": "calls", "dir": "out", "role": "calls", "type": None}]
            nodes[sid] = node

        edges: dict[str, dict] = {}
        special_ports: dict[str, dict[str, None]] = {k: {} for k in SPECIAL}
        for e in raw:
            if e.source not in nodes and e.source not in SPECIAL or e.target not in nodes and e.target not in SPECIAL:
                continue
            src, sp, tgt, tp = _handles(e)
            for node_id, port in ((src, sp), (tgt, tp)):
                if node_id in SPECIAL:
                    special_ports[node_id][port] = None
            eid = f"{e.kind}|{src}|{sp}|{tgt}|{tp}"
            site = {"file": e.file, "line": e.line}
            if eid in edges:
                if site not in edges[eid]["sites"]:
                    edges[eid]["sites"].append(site)
                continue
            callee = e.target if e.kind in ("call", "method_call", "reference", "depends") else e.source if e.kind == "flow" else None
            type_out = None
            if callee in symbols:
                type_out = self._types.returns(*symbols[callee]) if self._types else UNKNOWN
            elif e.kind == "depends" and e.target in symbols:
                type_out = self._types.returns(*symbols[e.target]) if self._types else UNKNOWN
            edges[eid] = {
                "id": eid, "kind": e.kind, "source": src, "sourcePort": sp, "target": tgt, "targetPort": tp,
                "level": e.level, "external": IMPORTS in (src, tgt), "resolved": e.resolved,
                "typeIn": ", ".join(a["type"] or UNKNOWN for a in e.args) if e.args else None,
                "typeOut": type_out if e.resolved else (type_out or UNKNOWN),
                "label": e.label, "args": e.args, "sites": [site],
            }
        for sid, title in SPECIAL.items():
            nodes[sid] = {"id": sid, "kind": sid.strip("<>"), "label": title, "module": None, "qualname": sid,
                          "parentId": None, "file": None, "range": None, "isAsync": False,
                          "ports": [{"id": p, "name": p, "dir": "inout", "role": "symbol", "type": None}
                                    for p in sorted(special_ports[sid])]}
        if self.nest_single_use:
            _nest(nodes, list(edges.values()))
        return {"root": str(self.root), "nodes": list(nodes.values()), "edges": list(edges.values()),
                "errors": dict(self.errors)}


def _handles(e: RawEdge) -> tuple[str, str, str, str]:
    """Map a raw edge to drawn (source, sourcePort, target, targetPort)."""
    if e.kind == "depends":                      # provider's return feeds the consumer's parameter
        return e.target, "return", e.source, e.source_port or "in"
    if e.kind == "decorates":
        return e.source, e.source_port or "return", e.target, "in"
    if e.kind == "flow":                         # producer's return value reaches the consumer's parameter
        return e.source, "return", e.target, e.target_port or "in"
    if e.kind == "global_read":
        return GLOBALS, e.source_port or "", e.target, "in"
    if e.kind == "global_write":
        return e.source, "calls", GLOBALS, e.target_port or ""
    return e.source, "calls", e.target, e.target_port or "in"


def _touches(e: RawEdge, modules: set[str]) -> bool:
    ids = (e.source, e.target, e.source_port or "", e.target_port or "")
    return any(i == m or i.startswith(m + ".") for i in ids for m in modules)


def _nest(nodes: dict[str, dict], edges: list[dict]) -> None:
    """A function/lambda/property/method invoked from exactly one site moves inside its caller."""
    sites: dict[str, list[str]] = {}
    for e in edges:
        if e["kind"] not in _INVOKE:
            continue
        callee, caller = (e["source"], e["target"]) if e["kind"] in ("depends", "decorates") else (e["target"], e["source"])
        sites.setdefault(callee, []).extend([caller] * len(e["sites"]))
        if e["kind"] == "decorates":
            sites[callee].append("<decorator>")  # decorators are never nested
    for node_id, callers in sites.items():
        node = nodes.get(node_id)
        if node is None or node["kind"] not in NESTABLE or len(callers) != 1 or node.get("abstract"):
            continue
        caller = nodes.get(callers[0])
        if caller is None or caller["kind"] not in NESTABLE + ("decorator",) or caller["module"] != node["module"]:
            continue
        if node["kind"] in ("method", "property") and not caller["id"].startswith(node["parentId"] + "."):
            continue
        if _ancestor(nodes, caller["id"], node_id):
            continue
        node["nestedIn"] = caller["id"]
        node["parentId"] = caller["id"]


def _ancestor(nodes: dict[str, dict], node_id: str, candidate: str) -> bool:
    seen = set()
    while node_id and node_id not in seen:
        if node_id == candidate:
            return True
        seen.add(node_id)
        node_id = nodes.get(node_id, {}).get("parentId")
    return False


def diff(old: dict, new: dict) -> dict:
    on = {n["id"]: n for n in old["nodes"]}
    nn = {n["id"]: n for n in new["nodes"]}
    oe = {e["id"]: e for e in old["edges"]}
    ne = {e["id"]: e for e in new["edges"]}
    return {
        "removedNodes": [i for i in on if i not in nn],
        "upsertNodes": [n for i, n in nn.items() if on.get(i) != n],
        "removedEdges": [i for i in oe if i not in ne],
        "upsertEdges": [e for i, e in ne.items() if oe.get(i) != e],
        "errors": new.get("errors", {}),
    }
