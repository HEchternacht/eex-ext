"""Shared tracer logic: project filter, node ids, value formatting, event batching over a socket."""
from __future__ import annotations

import ast
import dataclasses
import enum
import fnmatch
import inspect
import itertools
import json
import os
import reprlib
import socket
import sys
import threading
import time
import types
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import CodeType, FrameType

DEFAULT_EXCLUDE = ["**/.venv/**", "**/venv/**", "**/site-packages/**", "**/node_modules/**", "**/__pycache__/**"]


@dataclass
class Options:
    port: int
    token: str
    root: str
    max_repr: int = 200
    flush_ms: int = 50
    globals: bool = False
    exclude: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE))
    value_depth: int = 3
    value_items: int = 20


class Sender:
    """Batches events (latest value wins per call site) and ships them as NDJSON every flush_ms."""

    def __init__(self, opts: Options):
        self.opts = opts
        self.lock = threading.Lock()
        self.send_lock = threading.Lock()
        self.pending: dict[tuple, dict] = {}
        self.sock: socket.socket | None = None
        self.stopped = threading.Event()
        try:
            self.sock = socket.create_connection(("127.0.0.1", opts.port), timeout=5)
            self.sock.settimeout(None)
            self._send({"hello": opts.token, "pid": os.getpid(), "python": sys.version.split()[0]})
        except OSError as exc:
            print(f"[codeflow] tracer could not connect: {exc}", file=sys.stderr)
            self.sock = None
        self.thread = threading.Thread(target=self._loop, name="codeflow-trace-sender", daemon=True)
        self.thread.start()

    @property
    def alive(self) -> bool:
        return self.sock is not None

    def _send(self, obj: dict) -> None:
        if self.sock is None:
            return
        try:
            with self.send_lock:
                self.sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))
        except (OSError, AttributeError):
            self.sock = None

    def send_now(self, obj: dict) -> None:
        """Unbatched message (pauses, inject results, errors)."""
        self._send(obj)

    def add(self, ev: dict) -> None:
        key = (ev["t"], ev["node"], ev.get("caller"), ev.get("port"))
        with self.lock:
            prev = self.pending.get(key)
            ev["count"] = (prev["count"] + 1) if prev else 1
            self.pending[key] = ev

    def flush(self) -> None:
        with self.lock:
            batch, self.pending = list(self.pending.values()), {}
        if batch:
            self._send({"events": batch})

    def _loop(self) -> None:
        while not self.stopped.wait(self.opts.flush_ms / 1000):
            self.flush()

    def close(self) -> None:
        self.stopped.set()
        self.flush()
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)   # graceful FIN even while the control reader holds a makefile
            except OSError:
                pass
            try:
                self.sock.close()
            finally:
                self.sock = None


class Project:
    """Decides which code objects belong to the project and maps them to graph node ids."""

    def __init__(self, opts: Options):
        self.root = os.path.normcase(os.path.abspath(opts.root))
        self.exclude = opts.exclude
        self._file_cache: dict[str, str | None] = {}     # co_filename -> module name or None
        self._node_cache: dict[CodeType, str | None] = {}
        self._ast_qualnames: dict[str, dict[int, str]] = {}

    def module_of(self, filename: str) -> str | None:
        if filename in self._file_cache:
            return self._file_cache[filename]
        mod = None
        path = os.path.normcase(os.path.abspath(filename))
        if path.endswith(".py") and path.startswith(self.root + os.sep):
            rel = "/" + os.path.relpath(path, self.root).replace(os.sep, "/")
            if not any(fnmatch.fnmatch(rel, p) for p in self.exclude):
                parts = rel[1:-3].split("/")
                if parts[-1] == "__init__":
                    parts.pop()
                mod = ".".join(parts)
        self._file_cache[filename] = mod
        return mod

    def node_id(self, code: CodeType) -> str | None:
        try:
            return self._node_cache[code]
        except KeyError:
            pass
        mod = self.module_of(code.co_filename)
        node = None
        if mod is not None:
            if code.co_name == "<module>":
                node = mod
            elif code.co_name == "__annotate__":
                node = None   # PEP 649 lazy annotations (3.14): compiler-generated, not user code
            else:
                qual = self._qualname(code)
                node = f"{mod}.{qual}" if qual else None
        self._node_cache[code] = node
        return node

    def _qualname(self, code: CodeType) -> str | None:
        qual = getattr(code, "co_qualname", None)
        if qual is None:  # Python < 3.11: recover from the source
            return self._ast_qualname(code)
        parts = [p for p in qual.split(".") if p != "<locals>"]
        if parts and parts[-1] == "<lambda>":
            parts[-1] = f"<lambda@L{code.co_firstlineno}>"
        if any(p.startswith("<") and not p.startswith("<lambda@") for p in parts):
            return None   # comprehensions / genexpr: not graph nodes
        return ".".join(parts)

    def _ast_qualname(self, code: CodeType) -> str | None:
        table = self._ast_qualnames.get(code.co_filename)
        if table is None:
            table = {}
            try:
                with open(code.co_filename, encoding="utf-8") as fh:
                    tree = ast.parse(fh.read())
            except (OSError, SyntaxError):
                tree = ast.Module(body=[], type_ignores=[])

            def walk(body, prefix):
                for n in body:
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        q = prefix + n.name
                        first = min([d.lineno for d in n.decorator_list] + [n.lineno])
                        table[first] = q
                        walk(n.body, q + ".")
            walk(tree.body, "")
            self._ast_qualnames[code.co_filename] = table
        if code.co_name == "<lambda>":
            return f"<lambda@L{code.co_firstlineno}>"
        return table.get(code.co_firstlineno)

    def callers_of(self, frame: FrameType | None, limit: int = 4) -> list[str]:
        """Nearest project frames above `frame`, closest first (library frames are skipped).

        Several are kept because wrappers (decorators) sit between the static caller and the callee.
        """
        out: list[str] = []
        f = frame.f_back if frame is not None else None
        while f is not None and len(out) < limit:
            node = self.node_id(f.f_code)
            if node is not None and (not out or out[-1] != node):
                out.append(node)
            f = f.f_back
        return out


class Formatter:
    def __init__(self, max_len: int, depth: int = 3, items: int = 20):
        self.max_len = max_len
        self.depth = depth
        self.items = items
        self.r = reprlib.Repr()
        self.r.maxstring = max_len
        self.r.maxother = max_len
        self.r.maxlevel = 3

    def short(self, v) -> str:
        try:
            text = self.r.repr(v)
        except Exception as exc:   # user __repr__ may fail
            text = f"<repr failed: {type(exc).__name__}>"
        return text[: self.max_len - 1] + "…" if len(text) > self.max_len else text

    def value(self, v) -> dict:
        return {"type": type(v).__name__, "value": self.short(v), "tree": self.tree(v)}

    def tree(self, v, depth: int | None = None, seen: frozenset = frozenset()) -> dict:
        """Structured value: {t: type, k: kind, r: short repr, n: size, items: [{key, v}], more: hidden count}.
        Containers and objects are expanded `depth` levels deep, `items` children each; cycles stop at `k: 'cycle'`."""
        depth = self.depth if depth is None else depth
        kind = _kind(v)
        node = {"t": _type_name(v), "k": kind, "r": self.short(v)}
        if kind in _SCALAR:
            return node
        if id(v) in seen:
            return {**node, "k": "cycle"}
        children = _children(v, kind)
        if children is None:
            return node
        node["n"] = children[0]
        if depth <= 0:
            return node
        seen = seen | {id(v)}
        items = []
        try:
            for key, child in itertools.islice(children[1], self.items):
                items.append({"key": key, "v": self.tree(child, depth - 1, seen)})
        except Exception:   # user iterators / properties may fail
            pass
        node["items"] = items
        if children[0] is not None and children[0] > len(items):
            node["more"] = children[0] - len(items)
        return node

    def args(self, frame: FrameType) -> list[dict]:
        code = frame.f_code
        n = code.co_argcount + code.co_kwonlyargcount
        n += bool(code.co_flags & 0x04) + bool(code.co_flags & 0x08)   # *args, **kwargs
        out = []
        local = frame.f_locals
        for name in code.co_varnames[:n]:
            if name in ("self", "cls") or name not in local:
                continue
            out.append({"name": name, **self.value(local[name])})
        return out


_SCALAR = {"none", "bool", "int", "float", "complex", "str", "bytes", "enum", "callable", "coroutine", "other"}


def _type_name(v) -> str:
    t = type(v)
    return t.__qualname__ if t.__module__ in ("builtins", "__main__") else f"{t.__module__}.{t.__qualname__}"


def _kind(v) -> str:
    if v is None:
        return "none"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, enum.Enum):
        return "enum"
    for k, t in (("int", int), ("float", float), ("complex", complex), ("str", str), ("bytes", (bytes, bytearray)),
                 ("dict", Mapping), ("list", list), ("tuple", tuple), ("set", (set, frozenset)),
                 ("exception", BaseException)):
        if isinstance(v, t):
            return k
    if inspect.iscoroutine(v) or inspect.isgenerator(v) or inspect.isasyncgen(v):
        return "coroutine"
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return "dataclass"
    if hasattr(type(v), "model_fields"):
        return "pydantic"
    if callable(v) or isinstance(v, (type, types.ModuleType)):
        return "callable"
    if hasattr(v, "__dict__") or hasattr(type(v), "__slots__"):
        return "object"
    return "other"


def _children(v, kind: str):
    """(size, iterator of (key, child)) for expandable values, else None. Never calls user methods but __iter__."""
    if kind == "dict":
        return len(v), ((repr(k) if not isinstance(k, str) else k, x) for k, x in v.items())
    if kind in ("list", "tuple"):
        return len(v), enumerate(v)
    if kind == "set":
        return len(v), enumerate(v)
    if kind == "exception":
        return len(v.args), (("args" if i == 0 else f"args[{i}]", a) for i, a in enumerate(v.args))
    if kind == "dataclass":
        fs = dataclasses.fields(v)
        return len(fs), ((f.name, getattr(v, f.name, None)) for f in fs)
    if kind == "pydantic":
        names = list(type(v).model_fields)
        return len(names), ((n, getattr(v, n, None)) for n in names)
    if kind == "object":
        d = getattr(v, "__dict__", None)
        if isinstance(d, dict):
            return len(d), iter(list(d.items()))
        slots = [s for c in type(v).__mro__ for s in getattr(c, "__slots__", ()) if hasattr(v, s)]
        return len(slots), ((s, getattr(v, s)) for s in slots)
    return None


def now_ms() -> float:
    return time.time() * 1000
