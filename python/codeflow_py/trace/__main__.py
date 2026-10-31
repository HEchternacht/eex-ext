"""Run a script or module under the tracer.

python -m codeflow_py.trace --port P --token T --root R [--max-repr N] [--flush-ms N] [--globals] [--exclude GLOB]...
                            -- (-m module | script.py) [args...]
"""
from __future__ import annotations

import argparse
import atexit
import os
import runpy
import sys

from . import start, stop
from .core import DEFAULT_EXCLUDE, Options


def main(argv: list[str]) -> None:
    if "--" not in argv:
        raise SystemExit("usage: python -m codeflow_py.trace [options] -- (-m module | script.py) [args...]")
    split = argv.index("--")
    p = argparse.ArgumentParser(prog="codeflow_py.trace")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--root", default=os.getcwd())
    p.add_argument("--max-repr", type=int, default=200)
    p.add_argument("--flush-ms", type=int, default=50)
    p.add_argument("--globals", action="store_true")
    p.add_argument("--value-depth", type=int, default=3)
    p.add_argument("--value-items", type=int, default=20)
    p.add_argument("--exclude", action="append", default=None)
    a = p.parse_args(argv[:split])
    target = argv[split + 1:]
    if not target:
        raise SystemExit("nothing to run after --")

    opts = Options(a.port, a.token, a.root, a.max_repr, a.flush_ms, a.globals, a.exclude or list(DEFAULT_EXCLUDE),
                   a.value_depth, a.value_items)
    # the traced program must not see our own package dir first, and must import from its own cwd
    sys.path[0] = os.getcwd()
    start(opts)
    atexit.register(stop)
    if target[0] == "-m":
        if len(target) < 2:
            raise SystemExit("-m needs a module name")
        sys.argv = [target[1]] + target[2:]
        runpy.run_module(target[1], run_name="__main__", alter_sys=True)
    else:
        sys.argv = target
        runpy.run_path(target[0], run_name="__main__")


if __name__ == "__main__":
    main(sys.argv[1:])
