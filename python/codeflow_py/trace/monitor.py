"""sys.monitoring backend (Python 3.12+). Library code is disabled per code object after its first event."""
from __future__ import annotations

import dis
import sys
import threading

from .core import Formatter, Options, Project, Sender, now_ms

_TOOL_NAME = "codeflow"


class MonitorTracer:
    def __init__(self, opts: Options, sender: Sender):
        self.opts = opts
        self.sender = sender
        self.project = Project(opts)
        self.fmt = Formatter(opts.max_repr, opts.value_depth, opts.value_items)
        self.local = threading.local()
        self.tool: int | None = None
        self.control = None   # set by start()
        self._global_writes: dict = {}

    def start(self) -> None:
        mon = sys.monitoring
        for tool in (5, 4, 3, mon.PROFILER_ID):
            try:
                mon.use_tool_id(tool, _TOOL_NAME)
                self.tool = tool
                break
            except ValueError:
                continue
        if self.tool is None:
            raise RuntimeError("no free sys.monitoring tool id")
        E = mon.events
        mon.register_callback(self.tool, E.PY_START, self._on_start)
        mon.register_callback(self.tool, E.PY_RETURN, self._on_return)
        mon.set_events(self.tool, E.PY_START | E.PY_RETURN)

    def stop(self) -> None:
        if self.tool is None:
            return
        mon = sys.monitoring
        mon.set_events(self.tool, 0)
        mon.register_callback(self.tool, mon.events.PY_START, None)
        mon.register_callback(self.tool, mon.events.PY_RETURN, None)
        mon.free_tool_id(self.tool)
        self.tool = None

    # reentrancy guard: repr() of project objects runs project code
    def _busy(self) -> bool:
        return getattr(self.local, "busy", False)

    def _on_start(self, code, offset):
        node = self.project.node_id(code)
        if node is None:
            return sys.monitoring.DISABLE
        if self._busy() or not self.sender.alive:
            return None
        self.local.busy = True
        try:
            frame = sys._getframe(1)
            callers = self.project.callers_of(frame)
            self.sender.add({"t": "call", "node": node, "caller": callers[0] if callers else None, "callers": callers,
                             "args": self.fmt.args(frame), "ts": now_ms()})
            if self.control:
                if code.co_flags & 0x80:   # CO_COROUTINE
                    self.control.note_coroutine()
                reason = self.control.wants_pause(node)
                if reason:
                    self.control.pause(reason, "call", node, callers, frame)
        finally:
            self.local.busy = False
        return None

    def _on_return(self, code, offset, retval):
        node = self.project.node_id(code)
        if node is None:
            return sys.monitoring.DISABLE
        if self._busy() or not self.sender.alive:
            return None
        self.local.busy = True
        try:
            frame = sys._getframe(1)
            callers = self.project.callers_of(frame)
            self.sender.add({"t": "return", "node": node, "caller": callers[0] if callers else None, "callers": callers,
                             "value": self.fmt.value(retval), "ts": now_ms()})
            if self.opts.globals:
                self._send_globals(code, frame, node)
            if self.control and self.control.follow:
                reason = self.control.wants_pause(node)
                if reason == "follow":
                    self.control.pause(reason, "return", node, callers, frame, retval)
        finally:
            self.local.busy = False
        return None

    def _send_globals(self, code, frame, node: str) -> None:
        names = self._global_writes.get(code)
        if names is None:
            names = self._global_writes[code] = {i.argval for i in dis.get_instructions(code) if i.opname == "STORE_GLOBAL"}
        if not names:
            return
        mod = self.project.module_of(code.co_filename)
        g = frame.f_globals
        for name in names:
            if name in g:
                self.sender.add({"t": "global", "node": node, "port": f"{mod}.{name}", "value": self.fmt.value(g[name]),
                                 "ts": now_ms()})
