"""SQLite connection management (stdlib sqlite3)."""
import sqlite3
from contextlib import contextmanager
from typing import Iterator, Optional

from fastapi import Depends

from ..config import Settings, get_settings
from ..logging_setup import get_logger

logger = get_logger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    price      REAL    NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    region     TEXT    NOT NULL DEFAULT 'eu',
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    priority   INTEGER NOT NULL,
    payload    TEXT    NOT NULL DEFAULT '{}',
    result     TEXT,
    error      TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    updated_at REAL
);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status);
"""


class Database:
    def __init__(self, path: str):
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
        logger.info("schema ready at %s", self.path)

    def __repr__(self):
        return f"Database({self.path!r})"


_database: Optional[Database] = None


def get_database(settings: Settings = Depends(get_settings)) -> Database:
    global _database
    if _database is None or _database.path != settings.db_path:
        _database = Database(settings.db_path)
    return _database


def get_db(database: Database = Depends(get_database)) -> Iterator[sqlite3.Connection]:
    """Per-request connection (generator dependency)."""
    with database.connect() as conn:
        yield conn
