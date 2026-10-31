from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, status

from ..dependencies import Pagination, get_item_service
from ..logging_setup import log_call
from ..models import ItemCreate, ItemOut, Page
from ..services import ItemService

router = APIRouter(prefix="/items", tags=["items"])


@router.post("", response_model=ItemOut, status_code=status.HTTP_201_CREATED)
def create_item(data: ItemCreate, service: ItemService = Depends(get_item_service)):
    return service.create(data)


@router.get("", response_model=Page[ItemOut])
def list_items(
    page: Pagination = Depends(),
    sort: str = Query("id", pattern=r"^-?(id|name|price|quantity)$"),
    service: ItemService = Depends(get_item_service),
):
    return service.list_items(page.limit, page.offset, sort)


@router.get("/search", response_model=list[ItemOut])
@log_call()
def search_items(
    q: str = Query(..., min_length=1),
    max_price: Optional[float] = Query(None, gt=0),
    service: ItemService = Depends(get_item_service),
):
    return service.search(q, max_price)


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: int = Path(..., ge=1), service: ItemService = Depends(get_item_service)) -> ItemOut:
    return service.get(item_id)


@router.post("/{item_id}/discount", response_model=ItemOut)
def discount_item(item_id: int, strategy: str = "ten", service: ItemService = Depends(get_item_service)):
    return service.discount(item_id, strategy)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: int, service: ItemService = Depends(get_item_service)) -> None:
    service.delete(item_id)
