from datetime import date

from app.recurrence import is_occurrence, occurrence_dates


def dates(*args):
    return [d.isoformat() for d in occurrence_dates(*args)]


def test_once():
    assert dates(date(2026, 5, 3), "once", 1, None, date(2026, 5, 1), date(2026, 5, 31)) == ["2026-05-03"]
    assert dates(date(2026, 5, 3), "once", 1, None, date(2026, 6, 1), date(2026, 6, 30)) == []


def test_monthly_clamps_to_month_end_without_drifting():
    got = dates(date(2026, 1, 31), "month", 1, None, date(2026, 1, 1), date(2026, 5, 31))
    assert got == ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]


def test_monthly_window_in_the_middle_of_series():
    got = dates(date(2020, 3, 15), "month", 3, None, date(2026, 1, 1), date(2026, 12, 31))
    assert got == ["2026-03-15", "2026-06-15", "2026-09-15", "2026-12-15"]


def test_biweekly_keeps_phase():
    got = dates(date(2026, 1, 2), "week", 2, None, date(2026, 10, 1), date(2026, 10, 31))
    assert got == ["2026-10-09", "2026-10-23"]


def test_end_date_is_inclusive():
    got = dates(date(2026, 1, 1), "day", 1, date(2026, 1, 3), date(2025, 12, 1), date(2026, 2, 1))
    assert got == ["2026-01-01", "2026-01-02", "2026-01-03"]


def test_yearly_leap_day():
    got = dates(date(2024, 2, 29), "year", 1, None, date(2024, 1, 1), date(2028, 12, 31))
    assert got == ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]


def test_is_occurrence():
    assert is_occurrence(date(2026, 1, 2), "week", 2, None, date(2026, 1, 16))
    assert not is_occurrence(date(2026, 1, 2), "week", 2, None, date(2026, 1, 9))
