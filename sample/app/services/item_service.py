"""Business logic for items, sitting between routers and the repository."""
from typing import Optional

from ..cache import TTLCache, cached
from ..config import Settings
from ..db import ItemRepository
from ..logging_setup import get_logger, log_call
from ..models import ItemCreate, ItemOut, Page
from .pricing import apply_discount, compute_total

logger = get_logger(__name__)


class ItemService:
    def __init__(self, repo: ItemRepository, cache: TTLCache, settings: Settings):
        self.repo = repo
        self.cache = cache
        self.settings = settings

    @staticmethod
    def _cache_key(item_id: int) -> tuple[str, int]:
        return ("item", item_id)

    def _with_total(self, item: ItemOut) -> ItemOut:
        return item.model_copy(update={"total": compute_total(item.price, item.quantity, item.region)})

    @log_call()
    def create(self, data: ItemCreate) -> ItemOut:
        item = self.repo.create(data)
        self.cache.invalidate()  # list pages are cached too
        logger.info("created item %s (%s)", item.id, item.name)
        return self._with_total(item)

    def get(self, item_id: int) -> ItemOut:
        key = self._cache_key(item_id)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        item = self._with_total(self.repo.get(item_id))
        self.cache.set(key, item)
        return item

    @cached(key_fn=lambda self, limit, offset, sort: ("items", limit, offset, sort))
    def list_items(self, limit, offset, sort):
        items = [self._with_total(i) for i in self.repo.list(limit=limit, offset=offset, order_by=sort)]
        return Page[ItemOut](items=items, total=self.repo.count(), limit=limit, offset=offset)

    def search(self, text: str, max_price: Optional[float] = None) -> list[ItemOut]:
        matches = self.repo.search(text, max_price)
        return sorted(map(self._with_total, matches), key=lambda i: (i.price, i.id))

    def discount(self, item_id: int, strategy: str) -> ItemOut:
        item = self.repo.get(item_id)
        updated = self.repo.update_price(item_id, apply_discount(item.price, strategy))
        self.cache.invalidate()
        return self._with_total(updated)

    def delete(self, item_id: int) -> None:
        self.repo.delete(item_id)
        self.cache.invalidate()
