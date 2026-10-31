"""Repository / DAO layer over sqlite3."""
from __future__ import annotations

import json
import sqlite3
import time
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Generic, Optional, Sequence, TypeVar

from ..exceptions import NotFoundError
from ..models import ItemCreate, ItemOut, JobCreate, JobOut, JobStatus

M = TypeVar("M")


class BaseRepository(ABC, Generic[M]):
    table: ClassVar[str]
    sortable: ClassVar[tuple[str, ...]] = ("id",)

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    @abstractmethod
    def _row_to_model(self, row: sqlite3.Row) -> M:
        """Convert a DB row to the domain model."""

    @property
    def entity_name(self) -> str:
        return self.table.rstrip("s").title()

    def get(self, ident: int) -> M:
        row = self.conn.execute(f"SELECT * FROM {self.table} WHERE id = ?", (ident,)).fetchone()
        if row is None:
            raise NotFoundError(self.entity_name, ident)
        return self._row_to_model(row)

    def list(self, limit: int = 50, offset: int = 0, order_by: str = "id") -> list[M]:
        if order_by.lstrip("-") not in self.sortable:
            raise ValueError(f"cannot sort by {order_by!r}")
        direction = "DESC" if order_by.startswith("-") else "ASC"
        rows = self.conn.execute(
            f"SELECT * FROM {self.table} ORDER BY {order_by.lstrip('-')} {direction} LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def count(self) -> int:
        return self.conn.execute(f"SELECT COUNT(*) FROM {self.table}").fetchone()[0]

    def delete(self, ident: int) -> None:
        self.get(ident)
        self._write(f"DELETE FROM {self.table} WHERE id = ?", (ident,))

    def _write(self, sql: str, params: Sequence[Any]) -> int:
        cur = self.conn.execute(sql, params)
        self.conn.commit()
        return cur.lastrowid


class ItemRepository(BaseRepository[ItemOut]):
    table = "items"
    sortable = ("id", "name", "price", "quantity")

    def _row_to_model(self, row):
        return ItemOut(**dict(row))

    def create(self, data: ItemCreate) -> ItemOut:
        new_id = self._write(
            "INSERT INTO items (name, price, quantity, region) VALUES (?, ?, ?, ?)",
            (data.name, data.price, data.quantity, data.region),
        )
        return self.get(new_id)

    def update_price(self, ident: int, price: float) -> ItemOut:
        self.get(ident)
        self._write("UPDATE items SET price = ? WHERE id = ?", (price, ident))
        return self.get(ident)

    def search(self, text: str, max_price: Optional[float] = None) -> list[ItemOut]:
        sql = "SELECT * FROM items WHERE name LIKE ?"
        params: list[Any] = [f"%{text}%"]
        if max_price is not None:
            sql += " AND price <= ?"
            params.append(max_price)
        return [self._row_to_model(r) for r in self.conn.execute(sql, params)]

    def iter_all(self):
        for row in self.conn.execute("SELECT * FROM items ORDER BY id"):
            yield self._row_to_model(row)


class JobRepository(BaseRepository[JobOut]):
    table = "jobs"
    sortable = ("id", "priority", "status")

    def _row_to_model(self, row: sqlite3.Row) -> JobOut:
        data = dict(row)
        data["payload"] = json.loads(data["payload"])
        data["result"] = self._decode(data["result"])
        return JobOut(**data)

    @staticmethod
    def _encode(value: Any) -> str:
        return json.dumps(value)

    @staticmethod
    def _decode(raw: Optional[str]) -> Any:
        return json.loads(raw) if raw is not None else None

    def create(self, job: JobCreate, status: JobStatus = JobStatus.QUEUED) -> JobOut:
        new_id = self._write(
            "INSERT INTO jobs (kind, status, priority, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
            (job.kind, status.value, int(job.priority), self._encode(job.payload), time.time()),
        )
        return self.get(new_id)

    def update_status(self, job_id: int, status: JobStatus, *, result: Any = None,
                      error: Optional[str] = None) -> None:
        fields = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status.value, time.time()]
        if status is JobStatus.RUNNING:
            fields.append("attempts = attempts + 1")
        if result is not None:
            fields.append("result = ?")
            params.append(self._encode(result))
        if error is not None:
            fields.append("error = ?")
            params.append(error)
        params.append(job_id)
        self._write(f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?", params)

    def by_status(self, status: Optional[JobStatus] = None, limit: int = 50) -> list[JobOut]:
        if status is None:
            return self.list(limit=limit, order_by="-id")
        rows = self.conn.execute(
            "SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT ?", (status.value, limit)
        ).fetchall()
        return list(map(self._row_to_model, rows))

    def count_by_status(self) -> dict[str, int]:
        rows = self.conn.execute("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
        return {r["status"]: r["n"] for r in rows}
