# EEX sample: FastAPI master/worker service

Test fixture for the EEX static analyser / runtime tracer. Small FastAPI app: items CRUD on SQLite, plus a master that hands jobs to async workers through a heap-based priority queue.

```
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m pytest -q          # 24 tests
.venv\Scripts\uvicorn app.main:app --reload
```

Env: `APP_DB_PATH`, `APP_WORKERS`, `APP_QUEUE_MAXSIZE`, `APP_CACHE_TTL`, `APP_API_KEY`, `APP_DEBUG`, `APP_LOG_LEVEL`, `APP_ALLOWED_KINDS`.

## Request / job flow

`POST /api/v1/jobs` → `routers/jobs.py:submit_job` → `Master.submit` (persists via `JobRepository.create`, then `PriorityJobQueue.put`) → `BaseWorker.run` → `queue.get` → `BaseWorker._handle` → `ThreadedWorker.process` → handler → callback `Master._on_status` → `JobRepository.update_status` + cache invalidation + listeners.

Job statuses: `queued → running → done | failed` (`models.py:JobStatus`).

## Where the complications are

| Complication | Location |
|---|---|
| Multiple routers, prefixes, nested include_router | `routers/__init__.py` (`api_router` prefix `/api/v1` includes items `/items`, jobs `/jobs`, admin `/admin`); `main.py:create_app` includes `health_router` + `api_router` |
| Router-level dependencies | `routers/admin.py:router` (`dependencies=[Depends(verify_api_key)]`) |
| Depends() chains (nested) | `routers/items.py:*` → `dependencies.py:get_item_service` → `get_item_repo` → `db/connection.py:get_db` → `get_database` → `config.py:get_settings` |
| Annotated dependency alias | `dependencies.py:SettingsDep`, used by `get_item_service`, `verify_api_key` |
| Class as dependency | `dependencies.py:Pagination`, used by `routers/items.py:list_items` (`Depends()` with no arg) |
| Dependency that is also called directly | `routers/jobs.py:validated_job` (dependency of `submit_job`, called directly in `submit_batch`) |
| Generator (yield) dependency + context manager | `db/connection.py:get_db` wraps `Database.connect` (`@contextmanager`) |
| Path / query / body / header params | `routers/items.py:get_item` (Path), `list_items`/`search_items` (Query), `jobs.py:submit_batch` (Body list), `dependencies.py:verify_api_key` (Header) |
| Pydantic models, generic model | `models.py` (`ItemCreate`, `ItemOut(ItemCreate)`, `JobCreate`, `JobOut`, `Page[T]`); `Page[ItemOut]` in `item_service.py:ItemService.list_items` and `routers/items.py:list_items` |
| Dataclasses | `config.py:Settings` (frozen), `models.py:QueuedJob` (order=True, `field(compare=False)`) |
| Enums with property | `models.py:JobStatus.is_terminal`, `Priority` (IntEnum) |
| Config from env, classmethod, lru_cache | `config.py:Settings.from_env`, `get_settings` |
| Abstract base + inheritance + overriding | `db/repository.py:BaseRepository` (abstract `_row_to_model`, generic `M`) → `ItemRepository`, `JobRepository`; `core/workers.py:BaseWorker` (abstract `process`) → `AsyncWorker` → `ThreadedWorker` (overrides `process`, adds `handle_price`) |
| Inherited method called on subclass | `BaseRepository.get/list/count/delete` used via `ItemRepository`/`JobRepository` |
| Method named like a builtin (`list`) | `db/repository.py:BaseRepository.list`; builtin `list(...)` used inside `JobRepository.by_status` |
| staticmethod / classmethod / property | `JobRepository._encode/_decode`, `ItemService._cache_key`; `Settings.from_env`; `Settings.is_secured`, `BaseRepository.entity_name`, `BaseWorker.busy`, `Master.running`, `TTLCache.hit_ratio`, `PriorityJobQueue.condition` (lazy) |
| ClassVar class attributes overridden | `BaseRepository.table/sortable` |
| Globals mutated with `global` | `logging_setup.py:configure_logging` (`_configured`); `cache.py:get_cache`, `reset_cache`, `cached.wrapper` (`_global_cache`, `cache_events`); `core/master.py:set_master` (`_master`); `core/workers.py:BaseWorker._handle` (`processed_total`); `middleware.py:request_context_middleware` (`REQUEST_COUNT`); `db/connection.py:get_database` (`_database`) |
| Module global mutated without `global` (item assignment) | `core/master.py:master_stats` in `Master.submit`, `Master._on_status`; `logging_setup.py:timings` in `timed.wrapper` |
| Decorator with functools.wraps | `logging_setup.py:log_call` (factory, sync + async branch), `cache.py:cached` (factory, key_fn lambda) |
| Decorator without wraps | `cache.py:memoize` (on `services/pricing.py:tax_rate`), `logging_setup.py:timed` (on `pricing.py:compute_inventory_value`) |
| Stacked decorators | `routers/items.py:search_items` (`@router.get` over `@log_call()`); `item_service.py:ItemService.list_items` (`@cached`); `Master.submit` (`@log_call()` on async method) |
| Decorator applied by call, not `@` | `main.py:create_app` (`app.middleware("http")(request_context_middleware)`); `pricing.py:DISCOUNTS["clearance"]` (`_floor_price(1.0)(make_discount(90))`) |
| functools.lru_cache | `cache.py:fibonacci` (recursive), `config.py:get_settings` |
| In-memory TTL cache class | `cache.py:TTLCache` (generic `K,V`, injectable clock, lock) |
| Closures / nested functions | `pricing.py:make_discount.apply`, `_floor_price.decorate`; `log_call.decorator.wrapper`; `memoize.inner` |
| Function attributes set on closures | `pricing.py:make_discount` (`apply.percent`), `cache.py:memoize` (`inner.memo`), `cached` (`wrapper.uncached`) |
| Lambdas | `workers.py:HANDLERS["reverse"/"fib"]`, `pricing.py:DISCOUNTS["none"]`, `_floor_price`, `item_service.py:list_items` key_fn + `search` sort key, `main.py:lifespan` listener, `queue.py:get` predicate, `master.py:submit_many` |
| Dynamic dispatch via dict | `workers.py:HANDLERS`, `pricing.py:DISCOUNTS` → `apply_discount` |
| getattr-based dispatch | `workers.py:AsyncWorker.resolve_handler` (`handle_<kind>` methods: `handle_sleep`, `handle_fail`, `handle_price`) |
| Duck typing | `services/report_service.py:collect_summaries` (`.summary()` on `Master`, `TTLCache`, or callable/Mapping); `workers.py:AsyncWorker.process` (`inspect.isawaitable`) |
| Callbacks passed as args | `Master.__init__` passes `self._on_status` into workers; `Master.add_listener`; `admin.py:stats` passes function `request_count` as a value |
| Async + sync mixed | async: `jobs.py:submit_job`, `Master.*`, workers; sync: items routes, repositories, `pricing.compute_inventory_value` run via `asyncio.to_thread` in `ThreadedWorker.process` |
| Circular-ish import handled locally | `core/master.py` → `core/workers.py` → (local import inside `ThreadedWorker.handle_price`) `services/pricing.py` → `core/master.py`; also `cache.py:get_cache` local-imports `config` |
| Relative imports / `__init__` re-exports | every module; re-exports in `app/__init__.py`, `db/__init__.py`, `core/__init__.py`, `services/__init__.py`, `routers/__init__.py` |
| Missing vs present annotations | annotated: `pricing.py:compute_total`; unannotated: `config.py:_env_list`, `workers.py:_sum`, `dependencies.py:get_job_repo`, `exceptions.py:value_error_handler` |
| Optional / Union / generics / Callable aliases | `workers.py:coerce_number` (Union), `StatusCallback`, `JobHandler`; `master.py:Listener`; `pricing.py:PriceFn`; `BaseRepository[M]`, `TTLCache[K, V]`, `Page[T]` |
| Param shadowing an imported module | `routers/jobs.py:list_jobs` (param `status` vs `fastapi.status`) |
| Generator method | `ItemRepository.iter_all` |
| Context managers | `Database.connect`, `TTLCache` lock, `PriorityJobQueue.get/put` (`async with` Condition), `main.py:lifespan` (`@asynccontextmanager`) |
| Priority queue (heapq) + async wait | `core/queue.py:PriorityJobQueue` |
| Custom exceptions + handlers | `exceptions.py` (`AppError` hierarchy, `register_exception_handlers`, also handles built-in `ValueError` → 400) |
| Middleware | `middleware.py:request_context_middleware` (request id, timing headers) |
| Lifespan startup/shutdown | `main.py:lifespan` (schema init, start/stop `Master` worker tasks) |
| Module-level code with side effects | `main.py` (`configure_logging(...)`, `app = create_app()`) |
| Logger per module + helper | `logging_setup.py:get_logger`; `logger = get_logger(__name__)` in most modules |

## Tests

`tests/` uses `TestClient` as a context manager (runs lifespan, so workers really run). Each test gets a fresh SQLite file via `APP_DB_PATH` + `get_settings.cache_clear()`. `tests/test_jobs.py` drives every job kind through the queue/worker path; `tests/test_units.py` covers cache, queue ordering, worker dispatch and duck typing without HTTP.
