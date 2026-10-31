"""Golden tests: analyser output over sample/ against the complications table in sample/README.md."""
import shutil
import time
from pathlib import Path

import pytest

from codeflow_py.analyze import Analyzer

SAMPLE = Path(__file__).resolve().parents[2] / "sample"
EXCLUDE = ["**/.venv/**", "**/__pycache__/**", "/tests/**", "**/.pytest_cache/**"]


@pytest.fixture(scope="module")
def graph():
    return Analyzer(str(SAMPLE), EXCLUDE).analyze()


def edges(graph, kind=None, source=None, target=None, **attrs):
    out = []
    for e in graph["edges"]:
        if kind and e["kind"] != kind or source and e["source"] != source or target and e["target"] != target:
            continue
        if all(e.get(k) == v for k, v in attrs.items()):
            out.append(e)
    return out


def node(graph, node_id):
    return next(n for n in graph["nodes"] if n["id"] == node_id)


def test_no_parse_errors_and_special_nodes(graph):
    assert graph["errors"] == {}
    ids = {n["id"] for n in graph["nodes"]}
    assert {"<imports>", "<globals>", "<unresolved>"} <= ids
    assert not any(i.startswith("tests") for i in ids)


def test_function_node_ports(graph):
    n = node(graph, "app.services.pricing.compute_total")
    ports = {p["id"]: p for p in n["ports"]}
    assert {"in", "return", "calls"} <= set(ports)
    assert all(p["type"] != "unknown" for p in ports.values() if p["role"] == "arg")
    assert ports["return"]["type"] != "unknown"
    # unannotated params fall back to 'unknown'
    assert node(graph, "app.core.workers._sum")["ports"][1]["type"] == "unknown"


def test_method_calls_level3(graph):
    assert edges(graph, "method_call", "app.core.master.Master.submit", "app.db.repository.JobRepository.create", level=3)
    assert edges(graph, "method_call", "app.core.master.Master.submit", "app.core.queue.PriorityJobQueue.put", level=3)


def test_function_calls_level2(graph):
    assert edges(graph, "call", "app.main.create_app", "app.exceptions.register_exception_handlers", level=2)


def test_depends_chain(graph):
    chain = [("app.dependencies.get_item_repo", "app.dependencies.get_item_service"),
             ("app.db.connection.get_db", "app.dependencies.get_item_repo"),
             ("app.db.connection.get_database", "app.db.connection.get_db"),
             ("app.config.get_settings", "app.db.connection.get_database")]
    for provider, consumer in chain:
        e = edges(graph, "depends", provider, consumer, level=2, label="Depends")
        assert e, (provider, consumer)
        assert e[0]["targetPort"].startswith("arg:")
    # endpoints get their service via Depends
    assert edges(graph, "depends", "app.dependencies.get_item_service", "app.routers.items.create_item")


def test_annotated_alias_dependency(graph):
    # SettingsDep = Annotated[Settings, Depends(get_settings)]
    assert edges(graph, "depends", "app.config.get_settings", "app.dependencies.verify_api_key")


def test_decorators(graph):
    assert edges(graph, "decorates", "app.cache.memoize", "app.services.pricing.tax_rate")
    assert edges(graph, "decorates", "app.logging_setup.timed", "app.services.pricing.compute_inventory_value")
    assert edges(graph, "decorates", "app.logging_setup.log_call", "app.core.master.Master.submit")
    assert node(graph, "app.cache.memoize")["kind"] == "decorator"
    # library decorators come from the Imports node
    assert edges(graph, "decorates", "<imports>", "app.cache.fibonacci", sourcePort="functools.lru_cache")


def test_router_wiring_through_globals(graph):
    # endpoints are fed by their router global; routers are read by create_app via api_router
    assert edges(graph, "global_read", "<globals>", "app.routers.items.list_items", sourcePort="app.routers.items.router")
    assert edges(graph, "global_read", "<globals>", "app.routers", sourcePort="app.routers.items.router")
    assert edges(graph, "global_write", "app.routers", "<globals>", targetPort="app.routers.api_router")
    assert edges(graph, "global_read", "<globals>", "app.main.create_app", sourcePort="app.routers.api_router")


def test_globals_mutation(graph):
    assert edges(graph, "global_write", "app.core.workers.BaseWorker._handle", "<globals>",
                 targetPort="app.core.workers.processed_total")
    # item assignment without `global`
    assert edges(graph, "global_write", "app.core.master.Master.submit", "<globals>",
                 targetPort="app.core.master.master_stats")
    # type aliases are not globals
    assert not [p for p in node(graph, "<globals>")["ports"] if p["id"].endswith(".JobHandler")]


def test_library_calls_only_via_imports(graph):
    project_ids = {n["id"] for n in graph["nodes"]}
    for e in graph["edges"]:
        assert e["source"] in project_ids and e["target"] in project_ids
    assert edges(graph, "call", "app.db.connection.Database.connect", "<imports>", external=True)
    ext = [e for e in graph["edges"] if e["external"]]
    assert all("<imports>" in (e["source"], e["target"]) for e in ext)


def test_dynamic_dispatch_is_unresolved_not_hidden(graph):
    dashed = edges(graph, source="app.core.workers.AsyncWorker.process", target="<unresolved>", resolved=False)
    assert dashed and dashed[0]["typeOut"] == "unknown"
    # HANDLERS table entries are references from the module
    assert edges(graph, "reference", "app.core.workers", "app.core.workers._square")
    # callbacks passed as values
    assert edges(graph, "reference", "app.core.master.Master.__init__", "app.core.master.Master._on_status")


def test_duck_typing_best_effort(graph):
    e = edges(graph, source="app.services.report_service.collect_summaries", resolved=False)
    assert e


def test_nesting(graph):
    # nested closure lives inside its factory
    assert node(graph, "app.services.pricing.make_discount.apply")["parentId"] == "app.services.pricing.make_discount"
    # property used from a single place nests in its caller (same class)
    assert node(graph, "app.core.workers.BaseWorker.busy")["parentId"] != "app.core.workers"
    # abstract methods never nest
    assert node(graph, "app.core.workers.BaseWorker.process")["parentId"] == "app.core.workers.BaseWorker"
    # decorators never nest
    assert node(graph, "app.cache.memoize")["parentId"] == "app.cache"


def test_lambdas_are_nodes(graph):
    lambdas = [n for n in graph["nodes"] if n["kind"] == "lambda"]
    assert any(n["id"].startswith("app.core.workers.<lambda@L") for n in lambdas)


def test_incremental_update(tmp_path):
    root = tmp_path / "proj"
    shutil.copytree(SAMPLE / "app", root / "app")
    a = Analyzer(str(root), EXCLUDE)
    a.analyze()
    pricing = root / "app" / "services" / "pricing.py"
    src = pricing.read_text(encoding="utf-8")
    pricing.write_text(src + "\n\ndef brand_new(x: int) -> int:\n    return compute_total(x, 1)\n", encoding="utf-8")
    patch = a.update([str(pricing)])
    assert any(n["id"] == "app.services.pricing.brand_new" for n in patch["upsertNodes"])
    assert any(e["source"] == "app.services.pricing.brand_new" for e in patch["upsertEdges"])
    pricing.write_text(src, encoding="utf-8")
    patch = a.update([str(pricing)])
    assert "app.services.pricing.brand_new" in patch["removedNodes"]


def test_performance():
    t = time.perf_counter()
    Analyzer(str(SAMPLE), EXCLUDE).analyze()
    assert time.perf_counter() - t < 15


def test_node_details(graph):
    """Specialised nodes: docstrings, signatures, decorators, class bases and fields."""
    assert node(graph, "app.services.pricing")["doc"].startswith("Pricing rules")
    assert node(graph, "app.services.pricing.make_discount")["doc"].startswith("Closure factory")
    assert node(graph, "app.services.pricing.compute_total")["signature"] == \
        "def compute_total(price: float, quantity: int, region: str='eu') -> float"
    settings = node(graph, "app.config.Settings")
    fields = {f["name"]: f for f in settings["fields"]}
    assert fields["worker_count"]["type"] == "int" and fields["worker_count"]["default"] == "2"
    assert fields["api_key"]["type"] == "Optional[str]"
    assert any(d.startswith("dataclass") for d in settings["decorators"])
    job = node(graph, "app.models.JobOut")
    assert job["bases"] == ["BaseModel"]
    assert [f["name"] for f in job["fields"]][:4] == ["id", "kind", "status", "priority"]
    assert {f["name"] for f in node(graph, "app.models.Priority")["fields"]} == {"HIGH", "NORMAL", "LOW"}
    cache = {f["name"]: f for f in node(graph, "app.cache.TTLCache")["fields"]}
    assert cache["ttl"]["type"] == "float"          # self.ttl = ttl takes the parameter annotation
    assert cache["_data"]["type"] == "dict[K, tuple[float, V]]"


def test_data_flow_bypasses_library_calls(tmp_path):
    (tmp_path / "pipe.py").write_text(
        "import random\n"
        "import statistics\n"
        "\n"
        "def get_list(n):\n"
        "    return [random.randint(0, 9) for _ in range(n)]\n"
        "\n"
        "def process(xs):\n"
        "    return statistics.mean(xs)\n"
        "\n"
        "def show(value, title=''):\n"
        "    print(title, value)\n"
        "\n"
        "def main():\n"
        "    xs = get_list(10)\n"
        "    ys = sorted(xs)\n"
        "    show(process(ys), title=str(len(xs)))\n"
        "    for x in get_list(3):\n"
        "        show(x)\n",
        encoding="utf-8")
    g = Analyzer(str(tmp_path), EXCLUDE).analyze()
    flows = {(e["source"], e["target"], e["targetPort"]): e for e in edges(g, kind="flow")}
    via = flows[("pipe.get_list", "pipe.process", "arg:xs")]   # xs -> sorted() -> process
    assert via["sourcePort"] == "return" and via["label"] == "via sorted" and via["level"] == 1
    assert flows[("pipe.process", "pipe.show", "arg:value")]["label"] is None
    assert ("pipe.get_list", "pipe.show", "arg:title") in flows   # through len() and str()
    assert ("pipe.get_list", "pipe.show", "arg:value") in flows   # for-loop variable
    assert not any(e["external"] for e in flows.values())
