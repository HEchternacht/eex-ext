from fastapi import APIRouter, Depends

from ..cache import get_cache
from ..core.master import Master, master_stats
from ..db import ItemRepository, JobRepository
from ..dependencies import get_item_repo, get_job_repo, get_master_dep, verify_api_key
from ..middleware import request_count
from ..services import build_report

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(verify_api_key)])


@router.get("/stats")
def stats(
    master: Master = Depends(get_master_dep),
    jobs: JobRepository = Depends(get_job_repo),
    items: ItemRepository = Depends(get_item_repo),
):
    return build_report(
        jobs.count_by_status(),
        items.count(),
        master=master,
        cache=get_cache(),
        requests=request_count,
        totals=master_stats,
    )


@router.get("/workers")
def workers(master: Master = Depends(get_master_dep)):
    return [w.summary() for w in master.workers]


@router.post("/cache/clear")
def clear_cache():
    cache = get_cache()
    size = len(cache)
    cache.invalidate()
    return {"cleared": size}
