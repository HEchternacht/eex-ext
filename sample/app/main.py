"""Application factory, lifespan (start/stop master + workers), wiring."""
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .core.master import Master, set_master
from .db import Database
from .exceptions import register_exception_handlers
from .logging_setup import configure_logging, get_logger
from .middleware import request_context_middleware
from .routers import api_router, health_router

configure_logging(get_settings().log_level)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    database = Database(settings.db_path)
    database.init_schema()
    master = Master(database, worker_count=settings.worker_count, queue_maxsize=settings.queue_maxsize)
    master.add_listener(lambda job_id, status: logger.debug("job %s -> %s", job_id, status.value))
    await master.start()
    set_master(master)
    app.state.master = master
    app.state.database = database
    logger.info("%s up (db=%s)", settings.app_name, settings.db_path)
    try:
        yield
    finally:
        await master.stop()
        set_master(None)
        logger.info("shutdown complete")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)
    app.middleware("http")(request_context_middleware)
    register_exception_handlers(app)
    app.include_router(health_router)
    app.include_router(api_router)
    return app


app = create_app()
