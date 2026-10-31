import json
import subprocess
import sys
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]
SAMPLE = PY_ROOT.parent / "sample"


def test_jsonrpc_roundtrip():
    proc = subprocess.Popen([sys.executable, "-m", "codeflow_py"], cwd=PY_ROOT, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")
    reqs = [{"jsonrpc": "2.0", "id": 1, "method": "update", "params": {"files": []}},
            {"jsonrpc": "2.0", "id": 2, "method": "analyze",
             "params": {"root": str(SAMPLE), "exclude": ["**/.venv/**", "/tests/**"]}},
            {"jsonrpc": "2.0", "id": 3, "method": "update", "params": {"files": []}}]
    out, _ = proc.communicate("".join(json.dumps(r) + "\n" for r in reqs), timeout=120)
    r1, r2, r3 = (json.loads(l) for l in out.splitlines())
    assert r1["id"] == 1 and "error" in r1
    assert r2["id"] == 2 and len(r2["result"]["nodes"]) > 100
    assert r3["result"]["upsertNodes"] == [] and r3["result"]["removedNodes"] == []


def test_locate():
    from codeflow_py.server import _locate
    src = "class A:\n    @dec\n    def f(self):\n        return 1\n\n    def g(self):\n        pass\n"
    assert _locate({"source": src, "qualname": "A.f"}) == {"start": 2, "end": 4, "indent": 4}
    assert _locate({"source": src, "qualname": "A.h"}) is None
