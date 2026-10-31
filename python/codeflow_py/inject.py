"""Call one project function in a fresh process (run under the tracer so the pipeline lights up).

python -m codeflow_py.trace ... -- -m codeflow_py.inject <module.qualname> '<json {"args": [...], "kwargs": {...}, "self": ...}>'
Arguments are Python expressions evaluated in the function's module. The result goes back on the tracer socket.
"""
from __future__ import annotations

import json
import sys
import traceback

from .trace.control import call_node


def main(argv: list[str]) -> int:
    node, spec = argv[0], json.loads(argv[1]) if len(argv) > 1 else {}
    import codeflow_py.trace as tr
    control = getattr(tr._active, "control", None)
    try:
        value = call_node(node, spec.get("args", []), spec.get("kwargs", {}), spec.get("self"))
        print(f"{node} -> {value!r}")
        if control:
            control.sender.flush()
            control.sender.send_now({"injected": {"id": spec.get("id"), "node": node, "ok": True, "value": control.fmt.value(value)}})
        return 0
    except BaseException as exc:
        traceback.print_exc()
        if control:
            control.sender.flush()
            control.sender.send_now({"injected": {"id": spec.get("id"), "node": node, "ok": False,
                                                  "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(limit=8)}})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
