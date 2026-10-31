"""Commands from the extension on the tracer socket: follow mode, intercepts, injected calls.

The traced thread blocks inside the monitoring callback until the extension answers a pause (or the timeout /
a disconnect releases it). An asyncio event loop therefore pauses as a whole while one of its coroutines waits.
"""
from __future__ import annotations

import asyncio
import importlib
import itertools
import json
import os
import sys
import threading
import traceback
from types import FrameType

from .core import Formatter, Sender, now_ms


class Aborted(Exception):
    """Raised into the traced program when the user picks "Abort call" at an intercept."""


class Control:
    def __init__(self, sender: Sender, fmt: Formatter):
        self.sender = sender
        self.fmt = fmt
        self.intercept: set[str] = set()
        self.follow = False
        self.follow_nodes: set[str] | None = None    # None = every project node pauses in follow mode
        self.timeout = 300.0
        self.loop: asyncio.AbstractEventLoop | None = None   # the app's loop, captured when a coroutine runs on it
        self._ids = itertools.count(1)
        self._waiting: dict[int, tuple[threading.Event, dict]] = {}
        self._lock = threading.Lock()
        self.configured = threading.Event()   # first config received (intercepts apply from the first call)
        self.thread = threading.Thread(target=self._read, name="codeflow-trace-control", daemon=True)
        if sender.sock is not None:
            self.thread.start()

    # ---- traced side ---------------------------------------------------------------------------
    def wants_pause(self, node: str) -> str | None:
        if node in self.intercept:
            return "intercept"
        if self.follow and (self.follow_nodes is None or node in self.follow_nodes):
            return "follow"
        return None

    def pause(self, reason: str, t: str, node: str, callers: list[str], frame: FrameType, value=None) -> None:
        """Block this thread until the extension answers. Applies argument edits; raises Aborted on abort."""
        if not self.sender.alive:
            return
        pid = next(self._ids)
        ev = threading.Event()
        reply: dict = {}
        with self._lock:
            self._waiting[pid] = (ev, reply)
        self.sender.flush()   # the call event must reach the canvas before the pause
        msg = {"id": pid, "reason": reason, "t": t, "node": node, "callers": callers, "ts": now_ms(),
               "editable": sys.version_info >= (3, 13)}
        if t == "call":
            msg["args"] = self.fmt.args(frame)
        else:
            msg["value"] = self.fmt.value(value)
        self.sender.send_now({"pause": msg})
        if not ev.wait(self.timeout):
            self.sender.send_now({"resumed": {"id": pid, "why": "timeout"}})
        with self._lock:
            self._waiting.pop(pid, None)
        if reply.get("action") == "abort":
            raise Aborted(f"call to {node} aborted from Code Flow")
        edits = reply.get("args") or {}
        if edits and t == "call":
            self._edit(frame, edits, pid)

    def _edit(self, frame: FrameType, edits: dict, pid: int) -> None:
        if sys.version_info < (3, 13):
            self.sender.send_now({"error": {"id": pid, "message": "Editing arguments needs Python 3.13+ (PEP 667)."}})
            return
        for name, expr in edits.items():
            try:
                frame.f_locals[name] = eval(expr, frame.f_globals, dict(frame.f_locals))   # noqa: S307 - user typed
            except Exception as exc:
                self.sender.send_now({"error": {"id": pid, "message": f"{name} = {expr}: {type(exc).__name__}: {exc}"}})

    def note_coroutine(self) -> None:
        """Called when a project coroutine starts: remember the running loop for injected coroutine calls."""
        if self.loop is None:
            self.loop = asyncio._get_running_loop()

    # ---- extension side -------------------------------------------------------------------------
    def _read(self) -> None:
        try:
            for line in self.sender.sock.makefile("r", encoding="utf-8"):
                try:
                    self._command(json.loads(line))
                except Exception as exc:   # a bad command must not kill the reader
                    self.sender.send_now({"error": {"message": f"command failed: {exc}"}})
        except (OSError, ValueError):
            pass
        self.intercept, self.follow = set(), False
        self.configured.set()
        self.release_all()

    def _command(self, c: dict) -> None:
        cmd = c.get("cmd")
        if cmd == "config":
            self.intercept = set(c.get("intercept", []))
            self.follow = bool(c.get("follow", False))
            nodes = c.get("followNodes")
            self.follow_nodes = set(nodes) if nodes is not None else None
            self.timeout = float(c.get("timeout", self.timeout)) or 1e9
            self.configured.set()
            if not self.follow and not self.intercept:
                self.release_all("follow-off")
        elif cmd in ("resume", "abort"):
            with self._lock:
                w = self._waiting.get(c.get("id"))
            if w:
                w[1].update({"action": cmd, "args": c.get("args")})
                w[0].set()
        elif cmd == "inject":
            threading.Thread(target=self._inject, args=(c,), name="codeflow-inject", daemon=True).start()

    def release_all(self, why: str = "disconnect") -> None:
        with self._lock:
            waiting = list(self._waiting.values())
        for ev, reply in waiting:
            reply["action"] = "resume"
            ev.set()

    # ---- injected calls -------------------------------------------------------------------------
    def _inject(self, c: dict) -> None:
        iid = c.get("id")
        try:
            value = call_node(c["node"], c.get("args", []), c.get("kwargs", {}), c.get("self"), self.loop)
            self.sender.flush()
            self.sender.send_now({"injected": {"id": iid, "node": c["node"], "ok": True, "value": self.fmt.value(value)}})
        except BaseException as exc:   # report everything, including SystemExit from user code
            self.sender.flush()
            self.sender.send_now({"injected": {"id": iid, "node": c["node"], "ok": False,
                                               "error": f"{type(exc).__name__}: {exc}",
                                               "traceback": traceback.format_exc(limit=8)}})


def _loaded(modname: str):
    """An already-imported module, including the entry script (`__main__`) when its file is that module's file."""
    if modname in sys.modules:
        return sys.modules[modname]
    main = sys.modules.get("__main__")
    f = getattr(main, "__file__", None)
    if f and os.path.normcase(os.path.abspath(f)).endswith(os.sep + os.path.normcase(os.path.join(*modname.split("."))) + ".py"):
        return main
    return None


def resolve(node: str):
    """`pkg.mod.Class.method` -> (module globals, object). Tries the longest importable module prefix."""
    parts = node.split(".")
    for i in range(len(parts) - 1, 0, -1):
        modname = ".".join(parts[:i])
        try:
            mod = _loaded(modname) or importlib.import_module(modname)
        except ImportError:
            continue
        obj = mod
        for p in parts[i:]:
            if p.startswith("<"):
                raise LookupError(f"{node} is local to a function and can't be called from outside")
            obj = getattr(obj, p)
        return mod.__dict__, obj
    raise LookupError(f"can't import a module for {node}")


def call_node(node: str, args: list[str], kwargs: dict[str, str], self_expr: str | None, loop=None):
    """Evaluate the argument expressions in the function's module and call it (methods need `self_expr`)."""
    g, fn = resolve(node)
    if self_expr:
        target = eval(self_expr, g)   # noqa: S307 - expression typed by the user
        fn = getattr(target, node.rsplit(".", 1)[1])
    a = [eval(x, g) for x in args]   # noqa: S307
    kw = {k: eval(v, g) for k, v in kwargs.items()}   # noqa: S307
    result = fn(*a, **kw)
    if asyncio.iscoroutine(result):
        if loop is not None and loop.is_running():
            return asyncio.run_coroutine_threadsafe(result, loop).result()
        return asyncio.run(result)
    return result
