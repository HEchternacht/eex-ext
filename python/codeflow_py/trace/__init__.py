"""Runtime tracer: python -m codeflow_py.trace --port P --token T --root R -- (-m module | script.py) [args...]"""
from __future__ import annotations

import sys

from .core import Options, Sender

_active = None


def start(opts: Options):
    """Install the best available backend; returns the tracer (call .stop() and sender.close() to end)."""
    global _active
    sender = Sender(opts)
    if sys.version_info >= (3, 12):
        from .monitor import MonitorTracer as Backend
    else:
        from .settrace import SettraceTracer as Backend
    tracer = Backend(opts, sender)
    from .control import Control
    tracer.control = Control(sender, tracer.fmt)
    tracer.control.configured.wait(1.0)   # the extension sends intercepts / follow right after the hello
    tracer.start()
    _active = tracer
    return tracer


def stop() -> None:
    global _active
    if _active is not None:
        _active.stop()
        _active.sender.close()
        _active = None
