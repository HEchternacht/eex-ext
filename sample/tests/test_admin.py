from conftest import API, wait_for_job


def test_health_and_version(client):
    assert client.get("/health").json() == {"status": "ok", "workers_running": True}
    assert client.get("/version").json()["version"] == "0.3.1"


def test_admin_requires_api_key(client, auth):
    assert client.get(f"{API}/admin/stats").status_code == 401
    assert client.get(f"{API}/admin/stats", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get(f"{API}/admin/stats", headers=auth).status_code == 200


def test_stats_report(client, auth):
    client.post(f"{API}/items", json={"name": "x", "price": 1})
    job = client.post(f"{API}/jobs", json={"kind": "square", "payload": {"n": 3}}).json()
    wait_for_job(client, job["id"])
    report = client.get(f"{API}/admin/stats", headers=auth).json()
    assert report["items"] == 1
    assert report["jobs_by_status"] == {"done": 1}
    assert report["master"]["running"] is True
    assert len(report["master"]["workers"]) == 2
    assert report["requests"] >= 3
    assert {"hits", "misses", "size"} <= report["cache"].keys()
    assert report["healthy"] is True


def test_workers_and_cache_clear(client, auth):
    workers = client.get(f"{API}/admin/workers", headers=auth).json()
    assert [w["type"] for w in workers] == ["ThreadedWorker", "ThreadedWorker"]
    client.post(f"{API}/items", json={"name": "x", "price": 1})
    client.get(f"{API}/items/1")
    assert client.post(f"{API}/admin/cache/clear", headers=auth).json()["cleared"] >= 1
