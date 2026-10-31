"""Aggregated reporting built on duck typing: anything with .summary() works."""
from collections.abc import Mapping
from typing import Any


def collect_summaries(sources: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, source in sources.items():
        summary = getattr(source, "summary", None)
        if callable(summary):
            out[name] = summary()
        elif callable(source):
            out[name] = source()
        elif isinstance(source, Mapping):
            out[name] = dict(source)
        else:
            out[name] = repr(source)
    return out


def build_report(job_counts, item_count: int, **sources) -> dict[str, Any]:
    report = collect_summaries(sources)
    report["jobs_by_status"] = job_counts
    report["items"] = item_count
    report["healthy"] = all(
        part.get("running", True) for part in report.values() if isinstance(part, dict)
    )
    return report
