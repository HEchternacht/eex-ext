"""JSON-RPC 2.0 over stdio, one JSON object per line.

Methods:
  analyze   {root, exclude?, nestSingleUse?} -> Graph
  update    {files: [path]}                  -> GraphPatch
  locate    {source, qualname}               -> {start, end, indent} | null   (inline editor)
"""
from __future__ import annotations

import ast
import json
import sys
import traceback

from .analyze import Analyzer

_analyzer: Analyzer | None = None


def _analyze(params: dict) -> dict:
    global _analyzer
    _analyzer = Analyzer(params["root"], params.get("exclude"), params.get("nestSingleUse", True))
    return _analyzer.analyze()


def _update(params: dict) -> dict:
    if _analyzer is None:
        raise RuntimeError("analyze must be called first")
    return _analyzer.update(params["files"])


def _locate(params: dict) -> dict | None:
    """1-based line range (decorators included) of a def/class by qualname in the given source."""
    tree = ast.parse(params["source"])
    parts = params["qualname"].split(".")
    body: list[ast.stmt] = tree.body
    found: ast.AST | None = None
    for part in parts:
        found = next((n for n in body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                      and n.name == part), None)
        if found is None:
            return None
        body = found.body
    start = min([d.lineno for d in found.decorator_list] + [found.lineno])
    return {"start": start, "end": found.end_lineno, "indent": found.col_offset}


METHODS = {"analyze": _analyze, "update": _update, "locate": _locate}


def serve(stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        resp: dict = {"jsonrpc": "2.0", "id": req.get("id")}
        try:
            resp["result"] = METHODS[req["method"]](req.get("params") or {})
        except Exception as exc:  # report every failure to the client instead of dying
            resp["error"] = {"code": -32000, "message": str(exc), "data": traceback.format_exc()}
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()


if __name__ == "__main__":
    serve()
