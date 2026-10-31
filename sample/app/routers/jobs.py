from typing import Optional

from fastapi import APIRouter, Body, Depends, status

from ..cache import TTLCache, get_cache
from ..config import Settings, get_settings
from ..core.master import Master
from ..db import JobRepository
from ..dependencies import get_job_repo, get_master_dep
from ..exceptions import UnknownJobKindError
from ..models import JobCreate, JobOut, JobStatus, Priority
from ..services.pricing import enqueue_revaluation

router = APIRouter(prefix="/jobs", tags=["jobs"])


def validated_job(job: JobCreate, settings: Settings = Depends(get_settings)) -> JobCreate:
    """Dependency that parses the body and checks the job kind."""
    if job.kind not in settings.allowed_kinds:
        raise UnknownJobKindError(job.kind)
    return job


@router.post("", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
async def submit_job(job: JobCreate = Depends(validated_job), master: Master = Depends(get_master_dep)):
    return await master.submit(job)


@router.post("/batch", response_model=list[JobOut], status_code=status.HTTP_202_ACCEPTED)
async def submit_batch(
    jobs: list[JobCreate] = Body(..., min_length=1),
    master: Master = Depends(get_master_dep),
    settings: Settings = Depends(get_settings),
):
    for job in jobs:
        validated_job(job, settings)
    return await master.submit_many(jobs)


@router.post("/revalue", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
async def revalue_inventory(region: Optional[str] = None, urgent: bool = False):
    return await enqueue_revaluation(region, Priority.HIGH if urgent else Priority.LOW)


@router.get("", response_model=list[JobOut])
def list_jobs(status: Optional[JobStatus] = None, limit: int = 50, repo: JobRepository = Depends(get_job_repo)):
    return repo.by_status(status, limit)


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: int, repo: JobRepository = Depends(get_job_repo), cache: TTLCache = Depends(get_cache)):
    key = ("job", job_id)
    hit = cache.get(key)
    if hit is not None:
        return hit
    job = repo.get(job_id)
    if job.status.is_terminal:  # only finished jobs are immutable enough to cache
        cache.set(key, job)
    return job
