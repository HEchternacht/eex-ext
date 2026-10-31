"""Pydantic API models and internal dataclasses."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, IntEnum
from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"

    @property
    def is_terminal(self) -> bool:
        return self in (JobStatus.DONE, JobStatus.FAILED)


class Priority(IntEnum):
    HIGH = 0
    NORMAL = 5
    LOW = 9


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float = Field(gt=0)
    quantity: int = Field(default=1, ge=0)
    region: str = "eu"


class ItemOut(ItemCreate):
    id: int
    total: Optional[float] = None


class JobCreate(BaseModel):
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    priority: Priority = Priority.NORMAL


class JobOut(BaseModel):
    id: int
    kind: str
    status: JobStatus
    priority: int
    payload: dict[str, Any]
    result: Any = None
    error: Optional[str] = None
    attempts: int = 0


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


@dataclass(order=True)
class QueuedJob:
    """Heap entry: ordered by (priority, seq); the rest is excluded from comparison."""

    priority: int
    seq: int
    job_id: int = field(compare=False)
    kind: str = field(compare=False)
    payload: dict[str, Any] = field(default_factory=dict, compare=False)
