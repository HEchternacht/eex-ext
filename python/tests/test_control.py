"""Two-way tracer channel: intercept (edit / abort), follow-mode gating, disconnect, live and fresh inject."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]

SCRIPT = """
import time
def add(a, b):
    return a + b
def pipeline(x):
    return add(x, 1) * 10
print("RESULT", pipeline(1), flush=True)
time.sleep(float(__import__('os').environ.get('CF_SLEEP', '0')))
"""


class FakeExtension:
    """The extension's side of the socket: answers pauses through `on_pause`, collects everything."""

    def __init__(self, config: dict, on_pause=None):
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]
        self.config = config
        self.on_pause = on_pause or (lambda p: {"cmd": "resume", "id": p["id"]})
        self.msgs: list[dict] = []
        self.conn = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def send(self, obj):
        self.conn.sendall((json.dumps(obj) + "\n").encode())

    def _run(self):
        self.conn, _ = self.srv.accept()
        f = self.conn.makefile("r", encoding="utf-8")
        f.readline()                       # hello
        self.send({"cmd": "config", **self.config})
        try:
            self._loop(f)
        except OSError:                    # we hung up ourselves (disconnect test)
            pass

    def _loop(self, f):
        for line in f:
            m = json.loads(line)
            self.msgs.append(m)
            if "pause" in m:
                reply = self.on_pause(m["pause"])
                if reply:
                    self.send(reply)

    def pauses(self):
        return [m["pause"] for m in self.msgs if "pause" in m]

    def events(self):
        return [e for m in self.msgs if "events" in m for e in m["events"]]


def run(tmp_path, ext: FakeExtension, target=None, env=None):
    (tmp_path / "s.py").write_text(SCRIPT, encoding="utf-8")
    proc = subprocess.run([sys.executable, "-m", "codeflow_py.trace", "--port", str(ext.port), "--token", "t",
                           "--root", str(tmp_path), "--", *(target or ["s.py"])], cwd=tmp_path, capture_output=True,
                          text=True, env={**os.environ, "PYTHONPATH": str(PY_ROOT), **(env or {})}, timeout=60)
    ext.thread.join(timeout=5)
    return proc


def test_intercept_edits_arguments(tmp_path):
    ext = FakeExtension({"intercept": ["s.add"]},
                        lambda p: {"cmd": "resume", "id": p["id"], "args": {"a": "a + 41"}})
    proc = run(tmp_path, ext)
    assert "RESULT 430" in proc.stdout, proc.stderr          # (1 + 41 + 1) * 10
    (p,) = ext.pauses()
    assert p["reason"] == "intercept" and p["node"] == "s.add" and p["callers"][0] == "s.pipeline"
    assert [a["name"] for a in p["args"]] == ["a", "b"] and p["args"][0]["value"] == "1"


def test_intercept_abort_raises_in_program(tmp_path):
    ext = FakeExtension({"intercept": ["s.add"]}, lambda p: {"cmd": "abort", "id": p["id"]})
    proc = run(tmp_path, ext)
    assert proc.returncode != 0 and "Aborted" in proc.stderr and "RESULT" not in proc.stdout


def test_follow_mode_waits_for_each_step(tmp_path):
    gaps = []

    def slow(p):
        gaps.append(time.perf_counter())
        time.sleep(0.15)                     # the "animation"
        return {"cmd": "resume", "id": p["id"]}

    ext = FakeExtension({"follow": True}, slow)
    t0 = time.perf_counter()
    proc = run(tmp_path, ext)
    assert "RESULT 20" in proc.stdout
    steps = [(p["t"], p["node"]) for p in ext.pauses()]
    assert steps[:4] == [("call", "s"), ("call", "s.pipeline"), ("call", "s.add"), ("return", "s.add")]
    assert time.perf_counter() - t0 >= 0.15 * len(steps)     # the program never ran ahead of the acks
    # scope: only listed nodes pause
    ext2 = FakeExtension({"follow": True, "followNodes": ["s.add"]})
    run(tmp_path, ext2)
    assert {p["node"] for p in ext2.pauses()} == {"s.add"}


def test_disconnect_releases_paused_program(tmp_path):
    def hang_up(p):
        ext.conn.shutdown(socket.SHUT_RDWR)  # extension window closed mid-pause
        return None

    ext = FakeExtension({"intercept": ["s.add"]}, hang_up)
    proc = run(tmp_path, ext)
    assert "RESULT 20" in proc.stdout


def test_inject_live_and_fresh(tmp_path):
    ext = FakeExtension({})

    def inject_later():
        while not ext.events():
            time.sleep(0.05)
        ext.send({"cmd": "inject", "id": 7, "node": "s.add", "args": ["20", "22"]})

    threading.Thread(target=inject_later, daemon=True).start()
    run(tmp_path, ext, env={"CF_SLEEP": "2"})
    (res,) = [m["injected"] for m in ext.msgs if "injected" in m]
    assert res["ok"] and res["id"] == 7 and res["value"]["value"] == "42"
    assert any(e["node"] == "s.add" and e.get("args", [{}])[0].get("value") == "20" for e in ext.events())

    fresh = FakeExtension({})
    (tmp_path / "s.py").write_text(SCRIPT.replace('print("RESULT"', 'if __name__ == "__main__": print("RESULT"'), encoding="utf-8")
    proc = subprocess.run([sys.executable, "-m", "codeflow_py.trace", "--port", str(fresh.port), "--token", "t",
                           "--root", str(tmp_path), "--", "-m", "codeflow_py.inject", "s.pipeline", json.dumps({"args": ["4"], "id": 9})],
                          cwd=tmp_path, capture_output=True, text=True, timeout=60,
                          env={**os.environ, "PYTHONPATH": os.pathsep.join([str(PY_ROOT), str(tmp_path)])})
    fresh.thread.join(timeout=5)
    assert "s.pipeline -> 50" in proc.stdout, proc.stderr
    (res,) = [m["injected"] for m in fresh.msgs if "injected" in m]
    assert res["ok"] and res["value"]["value"] == "50"
    assert {e["node"] for e in fresh.events()} >= {"s.pipeline", "s.add"}
