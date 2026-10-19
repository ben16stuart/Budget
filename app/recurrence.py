"""Date math for recurring entries.

Every occurrence is computed from the series start date (never chained from the
previous occurrence), so a bill on the 31st lands on the last day of short
months and returns to the 31st afterwards.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Iterator

FREQUENCIES = ("once", "day", "week", "month", "year")


def add_months(start: date, months: int) -> date:
    total = start.month - 1 + months
    year = start.year + total // 12
    month = total % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def nth_occurrence(start: date, frequency: str, interval: int, n: int) -> date:
    if frequency == "once":
        return start
    if frequency == "day":
        return start + timedelta(days=n * interval)
    if frequency == "week":
        return start + timedelta(weeks=n * interval)
    if frequency == "month":
        return add_months(start, n * interval)
    if frequency == "year":
        return add_months(start, 12 * n * interval)
    raise ValueError(f"unknown frequency {frequency!r}")


def _first_index(start: date, frequency: str, interval: int, window_start: date) -> int:
    """Index of an occurrence on or just before window_start (never after it)."""
    if window_start <= start:
        return 0
    if frequency in ("day", "week"):
        step = interval * (7 if frequency == "week" else 1)
        return (window_start - start).days // step
    if frequency == "month":
        months = (window_start.year - start.year) * 12 + window_start.month - start.month
        return months // interval
    years = window_start.year - start.year
    return years // interval


def occurrence_dates(
    start: date,
    frequency: str,
    interval: int,
    end: date | None,
    window_start: date,
    window_end: date,
) -> Iterator[date]:
    """Yield the scheduled dates of a series that fall inside [window_start, window_end]."""
    last = window_end if end is None else min(end, window_end)
    if last < start or window_start > last:
        return
    if frequency == "once":
        if window_start <= start:
            yield start
        return
    interval = max(1, interval)
    n = _first_index(start, frequency, interval, window_start)
    while True:
        d = nth_occurrence(start, frequency, interval, n)
        if d > last:
            return
        if d >= window_start:
            yield d
        n += 1


def is_occurrence(start: date, frequency: str, interval: int, end: date | None, d: date) -> bool:
    return any(True for _ in occurrence_dates(start, frequency, interval, end, d, d))
