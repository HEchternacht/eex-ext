"""Run sample/'s own pytest suite under the tracer and check the captured events."""
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

PY_ROOT = Path(__file__).resolve().parents[1]
SAMPLE = PY_ROOT.parent / "sample"


def _collect(cmd_tail, cwd=SAMPLE, extra=()):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    lines: list[dict] = []

    def accept():
        conn, _ = srv.accept()
        with conn, conn.makefile(encoding="utf-8") as fh:
            for line in fh:
                lines.append(json.loads(line))

    t = threading.Thread(target=accept, daemon=True)
    t.start()
    env = {**os.environ, "PYTHONPATH": str(PY_ROOT)}
    proc = subprocess.run([sys.executable, "-m", "codeflow_py.trace", "--port", str(port), "--token", "tok",
                           "--root", str(cwd), *extra, "--", *cmd_tail],
                          cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
    t.join(timeout=10)
    srv.close()
    return proc, lines


@pytest.fixture(scope="module")
def traced():
    proc, lines = _collect(["-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert lines[0]["hello"] == "tok"
    return [e for l in lines[1:] for e in l["events"]]


def find(events, t, node, caller=None):
    return [e for e in events if e["t"] == t and e["node"] == node and (caller is None or caller in e["callers"])]


def test_square_job_value(traced):
    rets = find(traced, "return", "app.core.workers._square")
    assert rets, "square handler traced"
    calls = find(traced, "call", "app.core.workers._square")
    assert any(a["name"] == "payload" and a["type"] == "dict" for c in calls for a in c["args"])
    assert all(r["value"]["type"] == "int" for r in rets)


def test_caller_attribution(traced):
    # Master.submit is awaited by the submit_job endpoint coroutine, through the log_call wrapper
    assert find(traced, "call", "app.core.master.Master.submit")[0]["caller"] == "app.logging_setup.log_call.decorator.async_wrapper"
    assert find(traced, "call", "app.core.master.Master.submit", "app.routers.jobs.submit_job")
    assert find(traced, "call", "app.db.repository.JobRepository.create", "app.core.master.Master.submit")


def test_node_ids_match_analyzer(traced):
    from codeflow_py.analyze import Analyzer
    graph = Analyzer(str(SAMPLE), ["**/.venv/**", "**/__pycache__/**"]).analyze()
    ids = {n["id"] for n in graph["nodes"]}
    traced_ids = {e["node"] for e in traced}
    unknown = traced_ids - ids
    assert len(traced_ids) > 50
    assert not unknown, sorted(unknown)[:20]


def test_values_are_truncated(tmp_path):
    (tmp_path / "big.py").write_text("def f(x):\n    return x * 1000\n\nf('ab')\n", encoding="utf-8")
    proc, lines = _collect(["big.py"], cwd=tmp_path, extra=["--max-repr", "20"])
    assert proc.returncode == 0, proc.stderr
    events = [e for l in lines[1:] for e in l["events"]]
    ret = find(events, "return", "big.f")[0]
    assert len(ret["value"]["value"]) <= 20 and ("..." in ret["value"]["value"] or ret["value"]["value"].endswith("…"))


@pytest.mark.skipif(not Path(r"C:\Users").exists(), reason="windows py launcher")
def test_settrace_backend_py311(tmp_path):
    """Older interpreters use sys.settrace; same event shape."""
    try:
        exe = subprocess.run(["py", "-V:Astral/CPython3.11.13", "-c", "import sys;print(sys.executable)"], capture_output=True, text=True,
                             timeout=30).stdout.strip()
    except OSError:
        exe = ""
    if not exe:
        pytest.skip("python 3.11 not installed")
    (tmp_path / "s.py").write_text("def g(a):\n    return a + 1\n\nclass K:\n    def m(self):\n        return g(1)\n\nK().m()\n",
                                   encoding="utf-8")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    out: list[dict] = []
    th = threading.Thread(target=lambda: out.extend(json.loads(l) for l in srv.accept()[0].makefile(encoding="utf-8")),
                          daemon=True)
    th.start()
    subprocess.run([exe, "-m", "codeflow_py.trace", "--port", str(port), "--token", "t", "--root", str(tmp_path), "--",
                    "s.py"], cwd=tmp_path, env={**os.environ, "PYTHONPATH": str(PY_ROOT)}, check=True, timeout=60)
    th.join(timeout=10)
    events = [e for l in out[1:] for e in l["events"]]
    assert find(events, "call", "s.g", "s.K.m")
    assert find(events, "return", "s.g")[0]["value"]["value"] == "2"


def test_value_tree_shapes():
    import dataclasses
    import enum

    from codeflow_py.trace.core import Formatter

    @dataclasses.dataclass
    class Frame:
        rows: list
        name: str | None = None

    class Color(enum.Enum):
        RED = 1

    f = Formatter(200, depth=3, items=2)
    t = f.tree(Frame([[None, 1, "a"], [2]], None))
    assert (t["k"], t["n"]) == ("dataclass", 2)
    rows = t["items"][0]
    assert rows["key"] == "rows" and rows["v"]["k"] == "list" and rows["v"]["n"] == 2
    inner = rows["v"]["items"][0]["v"]
    assert inner["n"] == 3 and inner["more"] == 1                      # item cap
    assert [i["v"]["k"] for i in inner["items"]] == ["none", "int"]
    assert f.tree(Color.RED)["k"] == "enum"
    assert f.tree({"a": {"b": {"c": {"d": 1}}}})["items"][0]["v"]["items"][0]["v"]["items"][0]["v"].get("items") is None  # depth cap
    loop = []
    loop.append(loop)
    assert f.tree(loop)["items"][0]["v"]["k"] == "cycle"
    assert f.tree(ValueError("boom"))["k"] == "exception"
    assert f.value(3) == {"type": "int", "value": "3", "tree": {"t": "int", "k": "int", "r": "3"}}
