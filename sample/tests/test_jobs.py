from conftest import API, wait_for_job


def submit(client, kind, payload=None, priority=5):
    resp = client.post(f"{API}/jobs", json={"kind": kind, "payload": payload or {}, "priority": priority})
    assert resp.status_code == 202, resp.text
    return resp.json()


def test_square_job_lifecycle(client):
    job = submit(client, "square", {"n": 7})
    assert job["status"] == "queued"
    done = wait_for_job(client, job["id"])
    assert done["status"] == "done"
    assert done["result"] == 49
    assert done["attempts"] == 1


def test_handlers_dict_and_getattr_dispatch(client):
    cases = {
        "sum": ({"values": [1, "2.5", 3]}, 6.5),
        "reverse": ({"text": "abc"}, "cba"),
        "fib": ({"n": 20}, 6765),
        "sleep": ({"seconds": 0.01}, "slept"),
    }
    ids = {kind: submit(client, kind, payload)["id"] for kind, (payload, _) in cases.items()}
    for kind, (_, expected) in cases.items():
        assert wait_for_job(client, ids[kind])["result"] == expected, kind


def test_failing_job_marked_failed(client):
    job = submit(client, "fail", {"reason": "boom"})
    done = wait_for_job(client, job["id"])
    assert done["status"] == "failed"
    assert done["error"] == "boom"
    assert done["result"] is None


def test_unknown_kind_rejected(client):
    resp = client.post(f"{API}/jobs", json={"kind": "nope"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "unknown_job_kind"


def test_batch_and_status_filter(client):
    resp = client.post(f"{API}/jobs/batch", json=[
        {"kind": "square", "payload": {"n": 2}, "priority": 9},
        {"kind": "square", "payload": {"n": 3}, "priority": 0},
    ])
    assert resp.status_code == 202
    jobs = resp.json()
    assert [j["priority"] for j in jobs] == [0, 9]  # submit_many sorts by priority
    for j in jobs:
        wait_for_job(client, j["id"])
    done = client.get(f"{API}/jobs", params={"status": "done"}).json()
    assert {j["result"] for j in done} == {4, 9}


def test_revalue_uses_db_and_threaded_worker(client):
    client.post(f"{API}/items", json={"name": "a", "price": 10, "quantity": 1, "region": "eu"})
    client.post(f"{API}/items", json={"name": "b", "price": 100, "quantity": 2, "region": "us"})
    job = client.post(f"{API}/jobs/revalue", params={"urgent": True}).json()
    assert job["kind"] == "price" and job["priority"] == 0
    done = wait_for_job(client, job["id"])
    assert done["status"] == "done"
    assert done["result"] == {"items": 2, "total": 226.1, "region": None}

    us_job = client.post(f"{API}/jobs/revalue", params={"region": "us"}).json()
    assert wait_for_job(client, us_job["id"])["result"]["total"] == 214.0


def test_missing_job_404(client):
    assert client.get(f"{API}/jobs/12345").status_code == 404
