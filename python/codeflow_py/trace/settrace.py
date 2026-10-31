"""sys.settrace backend for Python < 3.12 (slower: every call is seen by the trace function)."""
from __future__ import annotations

import dis
import sys
import threading

from .core import Formatter, Options, Project, Sender, now_ms


class SettraceTracer:
    def __init__(self, opts: Options, sender: Sender):
        self.opts = opts
        self.sender = sender
        self.project = Project(opts)
        self.fmt = Formatter(opts.max_repr, opts.value_depth, opts.value_items)
        self.local = threading.local()
        self._global_writes: dict = {}
        self.control = None   # set by start()

    def _pause(self, t, node, callers, frame, value=None) -> None:
        from .control import Aborted
        reason = self.control.wants_pause(node) if self.control else None
        if not reason or (t == "return" and reason != "follow"):
            return
        try:
            self.control.pause(reason, t, node, callers, frame, value)
        except Aborted:   # an exception here would uninstall sys.settrace: abort needs the 3.12+ backend
            self.sender.send_now({"error": {"message": "Abort needs Python 3.12+ (sys.monitoring); the call continued."}})

    def start(self) -> None:
        threading.settrace(self._global_trace)
        sys.settrace(self._global_trace)

    def stop(self) -> None:
        sys.settrace(None)
        threading.settrace(None)  # type: ignore[arg-type]

    def _global_trace(self, frame, event, arg):
        if event != "call":
            return None
        node = self.project.node_id(frame.f_code)
        if node is None or getattr(self.local, "busy", False) or not self.sender.alive:
            return None
        self.local.busy = True
        try:
            callers = self.project.callers_of(frame)
            caller = callers[0] if callers else None
            self.sender.add({"t": "call", "node": node, "caller": caller, "callers": callers, "args": self.fmt.args(frame),
                             "ts": now_ms()})
            self._pause("call", node, callers, frame)
        finally:
            self.local.busy = False

        def local_trace(f, ev, a):
            if ev == "return" and not getattr(self.local, "busy", False):
                self.local.busy = True
                try:
                    self.sender.add({"t": "return", "node": node, "caller": caller, "callers": callers,
                                     "value": self.fmt.value(a), "ts": now_ms()})
                    if self.opts.globals:
                        self._send_globals(f, node)
                    self._pause("return", node, callers, f, a)
                finally:
                    self.local.busy = False
            return local_trace
        return local_trace

    def _send_globals(self, frame, node: str) -> None:
        code = frame.f_code
        names = self._global_writes.get(code)
        if names is None:
            names = self._global_writes[code] = {i.argval for i in dis.get_instructions(code) if i.opname == "STORE_GLOBAL"}
        mod = self.project.module_of(code.co_filename)
        for name in names:
            if name in frame.f_globals:
                self.sender.add({"t": "global", "node": node, "port": f"{mod}.{name}",
                                 "value": self.fmt.value(frame.f_globals[name]), "ts": now_ms()})
