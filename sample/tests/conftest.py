import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Must be set before `app.main` is imported (settings are read at import time).
os.environ.setdefault("APP_DB_PATH", os.path.join(tempfile.mkdtemp(), "bootstrap.db"))
os.environ["APP_API_KEY"] = "secret"
os.environ["APP_WORKERS"] = "2"

from fastapi.testclient import TestClient  # noqa: E402

from app.cache import reset_cache  # noqa: E402
from app.config import get_settings  # noqa: E402

API = "/api/v1"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "test.db"))
    get_settings.cache_clear()
    reset_cache()
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


@pytest.fixture
def auth():
    return {"X-API-Key": "secret"}


def wait_for_job(client, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"{API}/jobs/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish: {job}")
