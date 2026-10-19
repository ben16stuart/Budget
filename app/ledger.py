"""Expands entries into dated occurrences and projects account balances.

An account's balance is its opening balance at the start of its opening date,
plus every non-skipped occurrence dated on or after that date. Variable-amount
occurrences without an entered amount are projected with an estimate: the
entry's estimate if set, otherwise the most recent amount entered for it.
"""

from __future__ import annotations

import bisect
import sqlite3
from collections import defaultdict
from datetime import date, timedelta

from .recurrence import is_occurrence, occurrence_dates

OVERDUE_LOOKBACK_DAYS = 60
SEVERITY_ORDER = {"danger": 0, "warning": 1, "info": 2}


def _d(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _days(start: date, end: date):
    for i in range((end - start).days + 1):
        yield start + timedelta(days=i)


class Ledger:
    def __init__(self, conn: sqlite3.Connection):
        self.accounts = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")}
        self.entries = [dict(r) for r in conn.execute("SELECT * FROM entries ORDER BY id")]
        for e in self.entries:
            e["_start"] = _d(e["start_date"])
            e["_end"] = _d(e["end_date"])
            e["_created"] = _d(e["created_on"])
        self.entries_by_id = {e["id"]: e for e in self.entries}

        self.overrides: dict[tuple[int, str], dict] = {}
        self.overrides_by_entry: dict[int, list[dict]] = defaultdict(list)
        actuals: dict[int, list[tuple[str, int]]] = defaultdict(list)
        for r in conn.execute("SELECT * FROM occurrences ORDER BY occ_date"):
            ov = dict(r)
            self.overrides[(ov["entry_id"], ov["occ_date"])] = ov
            self.overrides_by_entry[ov["entry_id"]].append(ov)
            if ov["amount"] is not None and ov["status"] != "skipped":
                actuals[ov["entry_id"]].append((ov["occ_date"], ov["amount"]))
        # Sorted (occ_date, amount) pairs per entry, used for estimating variable amounts.
        self._actuals = dict(actuals)
        self._actual_dates = {k: [d for d, _ in v] for k, v in actuals.items()}

    # ------------------------------------------------------------------ occurrences

    def _estimate(self, entry: dict, occ_date: str) -> int:
        if entry["estimate"] is not None:
            return entry["estimate"]
        history = self._actuals.get(entry["id"])
        if not history:
            return 0
        i = bisect.bisect_left(self._actual_dates[entry["id"]], occ_date)
        # Most recent amount before this occurrence, else the earliest one after it.
        return history[i - 1][1] if i > 0 else history[0][1]

    def _make(self, e: dict, occ: date, ov: dict | None) -> dict:
        occ_s = occ.isoformat()
        eff = ov["date"] if ov and ov["date"] else occ_s
        actual = ov["amount"] if ov else None
        if actual is not None:
            amount, known = actual, True
        elif not e["variable"]:
            amount, known = e["amount"] or 0, True
        else:
            amount, known = self._estimate(e, occ_s), False
        return {
            "entry_id": e["id"],
            "occ_date": occ_s,
            "date": eff,
            "name": e["name"],
            "kind": e["kind"],
            "account_id": e["account_id"],
            "to_account_id": e["to_account_id"],
            "amount": amount,
            "amount_known": known,
            "actual_amount": actual,
            "variable": bool(e["variable"]),
            "recurring": e["frequency"] != "once",
            "autopay": bool(e["autopay"]),
            "payable": e["kind"] != "credit" and not e["autopay"],
            "remind_days": e["remind_days"],
            "category": e["category"],
            "status": ov["status"] if ov else "scheduled",
            "note": ov["note"] if ov else None,
            "moved": eff != occ_s,
        }

    def _entry_occurrence_dates(self, e: dict, start: date, end: date):
        return occurrence_dates(e["_start"], e["frequency"], e["interval"], e["_end"], start, end)

    def is_occurrence(self, entry_id: int, occ: date) -> bool:
        e = self.entries_by_id[entry_id]
        return is_occurrence(e["_start"], e["frequency"], e["interval"], e["_end"], occ)

    def occurrences(self, start: date, end: date) -> list[dict]:
        """All occurrences whose effective (possibly moved) date is within [start, end]."""
        s, t = start.isoformat(), end.isoformat()
        out = []
        for e in self.entries:
            for occ in self._entry_occurrence_dates(e, start, end):
                o = self._make(e, occ, self.overrides.get((e["id"], occ.isoformat())))
                if s <= o["date"] <= t:
                    out.append(o)
            # Occurrences scheduled outside the window but moved into it.
            for ov in self.overrides_by_entry.get(e["id"], ()):
                if ov["date"] and s <= ov["date"] <= t and not (s <= ov["occ_date"] <= t):
                    occ = date.fromisoformat(ov["occ_date"])
                    if self.is_occurrence(e["id"], occ):
                        out.append(self._make(e, occ, ov))
        out.sort(key=lambda o: (o["date"], o["kind"] != "credit", o["name"].lower()))
        return out

    # --------------------------------------------------------------------- balances

    def balances(self, start: date, end: date) -> dict[str, dict[int, int | None]]:
        """End-of-day balance of every account for each day in [start, end].

        A day before an account's opening date has no balance (None).
        """
        if not self.accounts:
            return {d.isoformat(): {} for d in _days(start, end)}
        first_open = min(date.fromisoformat(a["opening_date"]) for a in self.accounts.values())
        deltas: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for o in self.occurrences(min(first_open, start), end):
            if o["status"] == "skipped":
                continue
            amt = o["amount"] or 0
            if o["kind"] == "credit":
                deltas[o["account_id"]][o["date"]] += amt
            else:
                deltas[o["account_id"]][o["date"]] -= amt
                if o["kind"] == "transfer" and o["to_account_id"] in self.accounts:
                    deltas[o["to_account_id"]][o["date"]] += amt

        result: dict[str, dict[int, int | None]] = {d.isoformat(): {} for d in _days(start, end)}
        s = start.isoformat()
        for acct in self.accounts.values():
            opening = acct["opening_date"]
            acct_deltas = deltas.get(acct["id"], {})
            bal = acct["opening_balance"] + sum(
                v for k, v in acct_deltas.items() if opening <= k < s
            )
            for day in result:
                if day < opening:
                    result[day][acct["id"]] = None
                else:
                    bal += acct_deltas.get(day, 0)
                    result[day][acct["id"]] = bal
        return result

    def account_summaries(self, today: date, horizon_days: int) -> list[dict]:
        end = today + timedelta(days=horizon_days)
        daily = self.balances(today, end)
        out = []
        for acct in self.accounts.values():
            series = [(d, b[acct["id"]]) for d, b in daily.items() if b.get(acct["id"]) is not None]
            low = min(series, key=lambda x: x[1]) if series else (None, None)
            out.append(
                {
                    **acct,
                    "balance_today": daily[today.isoformat()].get(acct["id"]),
                    "lowest_balance": low[1],
                    "lowest_date": low[0],
                    "horizon_end": end.isoformat(),
                }
            )
        return out

    # ----------------------------------------------------------------------- alerts

    def action_items(self, today: date) -> list[dict]:
        """Occurrences that need the user: overdue or upcoming payments, missing amounts."""
        max_lead = max([e["remind_days"] for e in self.entries] + [0])
        lookback = today - timedelta(days=OVERDUE_LOOKBACK_DAYS)
        items = []
        for o in self.occurrences(lookback, today + timedelta(days=max_lead)):
            if o["status"] != "scheduled":
                continue
            entry = self.entries_by_id[o["entry_id"]]
            when = date.fromisoformat(o["date"])
            # Anything dated before the entry was added is assumed to be history.
            if when < entry["_created"]:
                continue
            days_until = (when - today).days
            in_lead = days_until <= o["remind_days"]
            reasons = []
            if o["variable"] and not o["amount_known"] and in_lead:
                reasons.append("needs_amount")
            if o["payable"]:
                if days_until < 0:
                    reasons.append("overdue")
                elif in_lead:
                    reasons.append("due_soon")
            if not reasons:
                continue
            urgent = days_until <= (2 if reasons == ["needs_amount"] else 1)
            items.append(
                {
                    **o,
                    "reasons": reasons,
                    "days_until": days_until,
                    "severity": "danger" if "overdue" in reasons or urgent else "warning",
                }
            )
        items.sort(key=lambda i: (SEVERITY_ORDER[i["severity"]], i["date"], i["name"].lower()))
        return items

    def balance_alerts(self, today: date, horizon_days: int) -> list[dict]:
        """Accounts projected to fall below their minimum, with a suggested transfer."""
        end = today + timedelta(days=horizon_days)
        daily = self.balances(today, end)
        occs = [o for o in self.occurrences(today, end) if o["status"] != "skipped"]

        # Money each account could give up over the horizon without dropping below
        # its own minimum (or zero when it has none).
        spare: dict[int, int] = {}
        for acct in self.accounts.values():
            if acct["type"] == "credit_card":
                continue
            values = [b[acct["id"]] for b in daily.values() if b.get(acct["id"]) is not None]
            if len(values) == len(daily):
                spare[acct["id"]] = min(values) - max(acct["min_balance"] or 0, 0)

        alerts = []
        for acct in self.accounts.values():
            minimum = acct["min_balance"]
            if minimum is None:
                continue
            series = [(d, b[acct["id"]]) for d, b in daily.items() if b.get(acct["id"]) is not None]
            start = next((i for i, (_, bal) in enumerate(series) if bal < minimum), None)
            if start is None:
                continue
            # The first dip: consecutive days below the minimum. Covering it is the
            # next thing to do; a later dip raises its own alert once this is handled.
            dip = []
            for d, bal in series[start:]:
                if bal >= minimum:
                    break
                dip.append((d, bal))
            first_date = dip[0][0]
            low_date, low_bal = min(dip, key=lambda x: x[1])
            shortfall = minimum - low_bal
            triggers = [
                o["name"]
                for o in occs
                if o["date"] == first_date and o["account_id"] == acct["id"] and o["kind"] != "credit"
            ]
            first = date.fromisoformat(first_date)
            by_date = max(today, first - timedelta(days=1))
            suggestion = None
            donors = [(aid, amt) for aid, amt in spare.items() if aid != acct["id"] and amt > 0]
            if donors:
                aid, amt = max(donors, key=lambda x: x[1])
                suggestion = {
                    "from_account_id": aid,
                    "from_account_name": self.accounts[aid]["name"],
                    "amount": min(shortfall, amt),
                    "covers_shortfall": amt >= shortfall,
                    "available": amt,
                    "by_date": by_date.isoformat(),
                }
            alerts.append(
                {
                    "account_id": acct["id"],
                    "account_name": acct["name"],
                    "min_balance": minimum,
                    "first_breach_date": first_date,
                    "lowest_balance": low_bal,
                    "lowest_date": low_date,
                    "recovers_on": series[start + len(dip)][0] if start + len(dip) < len(series) else None,
                    "horizon_lowest": min(bal for _, bal in series),
                    "shortfall": shortfall,
                    "triggers": triggers,
                    "by_date": by_date.isoformat(),
                    "severity": "danger" if (first - today).days <= 7 else "warning",
                    "suggestion": suggestion,
                }
            )
        alerts.sort(key=lambda a: a["first_breach_date"])
        return alerts

    def upcoming(self, today: date, days: int) -> list[dict]:
        return [
            o
            for o in self.occurrences(today, today + timedelta(days=days))
            if o["status"] != "skipped"
        ]

    def next_dates(self, today: date, within_days: int = 800) -> dict[int, str]:
        """Next non-skipped occurrence date per entry, on or after today."""
        nxt: dict[int, str] = {}
        for o in self.occurrences(today, today + timedelta(days=within_days)):
            if o["status"] != "skipped" and o["entry_id"] not in nxt:
                nxt[o["entry_id"]] = o["date"]
        return nxt
