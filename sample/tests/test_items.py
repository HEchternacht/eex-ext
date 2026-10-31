from conftest import API


def make_item(client, **overrides):
    body = {"name": "widget", "price": 10.0, "quantity": 2, "region": "eu", **overrides}
    resp = client.post(f"{API}/items", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_and_get_item(client):
    item = make_item(client)
    assert item["id"] == 1
    assert item["total"] == 24.2  # 10 * 2 * 1.21

    resp = client.get(f"{API}/items/{item['id']}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "widget"
    assert "X-Request-ID" in resp.headers
    assert "X-Process-Time-ms" in resp.headers


def test_list_pagination_and_sort(client):
    for i, price in enumerate([5.0, 1.0, 3.0]):
        make_item(client, name=f"item{i}", price=price)
    page = client.get(f"{API}/items", params={"limit": 2, "sort": "-price"}).json()
    assert page["total"] == 3
    assert [i["price"] for i in page["items"]] == [5.0, 3.0]

    page2 = client.get(f"{API}/items", params={"limit": 2, "offset": 2, "sort": "-price"}).json()
    assert [i["price"] for i in page2["items"]] == [1.0]


def test_list_cache_invalidated_on_create(client):
    make_item(client)
    assert client.get(f"{API}/items").json()["total"] == 1
    make_item(client, name="second")
    assert client.get(f"{API}/items").json()["total"] == 2


def test_search(client):
    make_item(client, name="red apple", price=2.0, region="us")
    make_item(client, name="green apple", price=8.0)
    make_item(client, name="banana", price=1.0)
    results = client.get(f"{API}/items/search", params={"q": "apple", "max_price": 5}).json()
    assert [r["name"] for r in results] == ["red apple"]
    assert results[0]["total"] == 4.28  # 2.0 * 2 * 1.07


def test_discount_strategies(client):
    item = make_item(client, price=100.0, quantity=1)
    resp = client.post(f"{API}/items/{item['id']}/discount", params={"strategy": "half"})
    assert resp.json()["price"] == 50.0
    resp = client.post(f"{API}/items/{item['id']}/discount", params={"strategy": "clearance"})
    assert resp.json()["price"] == 5.0
    resp = client.post(f"{API}/items/{item['id']}/discount", params={"strategy": "bogus"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "bad_value"


def test_not_found_uses_custom_handler(client):
    resp = client.get(f"{API}/items/999")
    assert resp.status_code == 404
    assert resp.json() == {
        "error": "not_found",
        "message": "Item 999 not found",
        "details": {"entity": "Item", "id": 999},
    }


def test_validation_and_delete(client):
    assert client.post(f"{API}/items", json={"name": "", "price": -1}).status_code == 422
    item = make_item(client)
    assert client.delete(f"{API}/items/{item['id']}").status_code == 204
    assert client.get(f"{API}/items/{item['id']}").status_code == 404
