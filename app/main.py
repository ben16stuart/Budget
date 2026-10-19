from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, notify
from .ledger import Ledger
from .models import AccountIn, EntryIn, EntryUpdate, OccurrencePatch, SettingsIn

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_RANGE_DAYS = 400

ACCOUNT_COLS = ("name", "type", "opening_balance", "opening_date", "min_balance", "color", "notes")
ENTRY_COLS = (
    "name", "kind", "account_id", "to_account_id", "amount", "variable", "estimate", "frequency",
    "interval", "start_date", "end_date", "autopay", "remind_days", "category", "notes",
)
OCC_COLS = ("entry_id", "occ_date", "date", "amount", "status", "note")


def _row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None


def _values(model, cols) -> list:
    data = model.model_dump()
    return [data[c].isoformat() if isinstance(data[c], date) else data[c] for c in cols]


def _today(today: Optional[date]) -> date:
    return today or date.today()


def create_app(db_path: str | None = None, start_scheduler: bool = True) -> FastAPI:
    """App factory; run with `uvicorn app.main:create_app --factory`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    db.init_db(db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        scheduler = None
        if start_scheduler and notify.channels(notify.config()):
            scheduler = notify.DigestScheduler(db_path)
            scheduler.start()
        yield
        if scheduler:
            scheduler.stop()

    app = FastAPI(title="Budget", lifespan=lifespan)

    def get_conn():
        conn = db.connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    @app.exception_handler(sqlite3.IntegrityError)
    async def integrity_error(_: Request, exc: sqlite3.IntegrityError):
        return JSONResponse(status_code=400, content={"detail": f"Invalid data: {exc}"})

    # ------------------------------------------------------------------ misc

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/settings")
    def get_settings(conn=Depends(get_conn)):
        s = db.get_settings(conn)
        s.pop("last_digest", None)
        return s

    @app.put("/api/settings")
    def put_settings(body: SettingsIn, conn=Depends(get_conn)):
        for key, value in body.model_dump(exclude_none=True).items():
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()
        return get_settings(conn)

    # -------------------------------------------------------------- accounts

    def _account_or_404(conn, account_id: int) -> dict:
        acct = _row(conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone())
        if not acct:
            raise HTTPException(404, "Account not found")
        return acct

    @app.get("/api/accounts")
    def list_accounts(today: Optional[date] = None, conn=Depends(get_conn)):
        horizon = int(db.get_settings(conn)["horizon_days"])
        return Ledger(conn).account_summaries(_today(today), horizon)

    @app.post("/api/accounts", status_code=201)
    def create_account(body: AccountIn, conn=Depends(get_conn)):
        cur = conn.execute(
            f"INSERT INTO accounts ({', '.join(ACCOUNT_COLS)}) VALUES ({', '.join('?' * len(ACCOUNT_COLS))})",
            _values(body, ACCOUNT_COLS),
        )
        conn.commit()
        return _account_or_404(conn, cur.lastrowid)

    @app.put("/api/accounts/{account_id}")
    def update_account(account_id: int, body: AccountIn, conn=Depends(get_conn)):
        _account_or_404(conn, account_id)
        conn.execute(
            f"UPDATE accounts SET {', '.join(f'{c} = ?' for c in ACCOUNT_COLS)} WHERE id = ?",
            [*_values(body, ACCOUNT_COLS), account_id],
        )
        conn.commit()
        return _account_or_404(conn, account_id)

    @app.delete("/api/accounts/{account_id}", status_code=204)
    def delete_account(account_id: int, conn=Depends(get_conn)):
        _account_or_404(conn, account_id)
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()

    # --------------------------------------------------------------- entries

    def _entry_or_404(conn, entry_id: int) -> dict:
        entry = _row(conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone())
        if not entry:
            raise HTTPException(404, "Entry not found")
        return entry

    def _insert_entry(conn, body: EntryIn, created_on: str) -> int:
        cols = (*ENTRY_COLS, "created_on")
        cur = conn.execute(
            f"INSERT INTO entries ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            [*_values(body, ENTRY_COLS), created_on],
        )
        return cur.lastrowid

    @app.get("/api/entries")
    def list_entries(today: Optional[date] = None, conn=Depends(get_conn)):
        ledger = Ledger(conn)
        nxt = ledger.next_dates(_today(today))
        out = []
        for e in ledger.entries:
            item = {k: v for k, v in e.items() if not k.startswith("_")}
            item["variable"] = bool(item["variable"])
            item["autopay"] = bool(item["autopay"])
            item["next_date"] = nxt.get(e["id"])
            out.append(item)
        return out

    @app.get("/api/entries/{entry_id}")
    def get_entry(entry_id: int, conn=Depends(get_conn)):
        return _entry_or_404(conn, entry_id)

    @app.post("/api/entries", status_code=201)
    def create_entry(body: EntryIn, today: Optional[date] = None, conn=Depends(get_conn)):
        # Occurrences dated before this day are treated as history, not as overdue.
        entry_id = _insert_entry(conn, body, _today(today).isoformat())
        conn.commit()
        return _entry_or_404(conn, entry_id)

    @app.put("/api/entries/{entry_id}")
    def update_entry(entry_id: int, body: EntryUpdate, conn=Depends(get_conn)):
        old = _entry_or_404(conn, entry_id)
        old_start = date.fromisoformat(old["start_date"])
        split_at = body.effective_from
        if split_at and old["frequency"] != "once" and split_at > old_start:
            # Changes apply from split_at on: end the old series just before the
            # new one starts and hand over the later per-occurrence changes.
            cutoff = min(split_at, body.start_date)
            new_id = _insert_entry(conn, body, old["created_on"])
            conn.execute(
                "UPDATE occurrences SET entry_id = ? WHERE entry_id = ? AND occ_date >= ?",
                (new_id, entry_id, cutoff.isoformat()),
            )
            old_end = cutoff - timedelta(days=1)
            if old_end < old_start:
                conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            else:
                if old["end_date"]:
                    old_end = min(old_end, date.fromisoformat(old["end_date"]))
                conn.execute("UPDATE entries SET end_date = ? WHERE id = ?", (old_end.isoformat(), entry_id))
            conn.commit()
            return _entry_or_404(conn, new_id)
        conn.execute(
            f"UPDATE entries SET {', '.join(f'{c} = ?' for c in ENTRY_COLS)} WHERE id = ?",
            [*_values(body, ENTRY_COLS), entry_id],
        )
        conn.commit()
        return _entry_or_404(conn, entry_id)

    @app.delete("/api/entries/{entry_id}", status_code=204)
    def delete_entry(entry_id: int, conn=Depends(get_conn)):
        _entry_or_404(conn, entry_id)
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        conn.commit()

    # ----------------------------------------------------------- occurrences

    @app.patch("/api/occurrences/{entry_id}/{occ_date}")
    def patch_occurrence(entry_id: int, occ_date: date, body: OccurrencePatch, conn=Depends(get_conn)):
        _entry_or_404(conn, entry_id)
        if not Ledger(conn).is_occurrence(entry_id, occ_date):
            raise HTTPException(400, "That date is not an occurrence of this entry")
        key = (entry_id, occ_date.isoformat())
        current = _row(
            conn.execute("SELECT * FROM occurrences WHERE entry_id = ? AND occ_date = ?", key).fetchone()
        ) or {"date": None, "amount": None, "status": "scheduled", "note": None}
        for field in body.model_fields_set:
            value = getattr(body, field)
            if field == "date":
                value = None if value in (None, occ_date) else value.isoformat()
            elif field == "status":
                value = value or "scheduled"
            elif field == "note":
                value = (value or "").strip() or None
            current[field] = value
        if current["date"] is None and current["amount"] is None and current["status"] == "scheduled" and not current["note"]:
            conn.execute("DELETE FROM occurrences WHERE entry_id = ? AND occ_date = ?", key)
        else:
            conn.execute(
                "INSERT OR REPLACE INTO occurrences (entry_id, occ_date, date, amount, status, note) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (*key, current["date"], current["amount"], current["status"], current["note"]),
            )
        conn.commit()
        return get_occurrence(entry_id, occ_date, conn)

    @app.get("/api/occurrences/{entry_id}/{occ_date}")
    def get_occurrence(entry_id: int, occ_date: date, conn=Depends(get_conn)):
        ledger = Ledger(conn)
        if entry_id not in ledger.entries_by_id or not ledger.is_occurrence(entry_id, occ_date):
            raise HTTPException(404, "Occurrence not found")
        e = ledger.entries_by_id[entry_id]
        return ledger._make(e, occ_date, ledger.overrides.get((entry_id, occ_date.isoformat())))

    @app.delete("/api/occurrences/{entry_id}/{occ_date}", status_code=204)
    def reset_occurrence(entry_id: int, occ_date: date, conn=Depends(get_conn)):
        conn.execute(
            "DELETE FROM occurrences WHERE entry_id = ? AND occ_date = ?", (entry_id, occ_date.isoformat())
        )
        conn.commit()

    # -------------------------------------------------------- calendar/alerts

    @app.get("/api/calendar")
    def calendar(start: date, end: date, conn=Depends(get_conn)):
        if end < start or (end - start).days > MAX_RANGE_DAYS:
            raise HTTPException(400, f"Range must be 0-{MAX_RANGE_DAYS} days")
        ledger = Ledger(conn)
        return {
            "occurrences": ledger.occurrences(start, end),
            "balances": ledger.balances(start, end),
        }

    @app.get("/api/alerts")
    def alerts(today: Optional[date] = None, conn=Depends(get_conn)):
        today = _today(today)
        settings = db.get_settings(conn)
        ledger = Ledger(conn)
        return {
            "today": today.isoformat(),
            "action_items": ledger.action_items(today),
            "balance_alerts": ledger.balance_alerts(today, int(settings["horizon_days"])),
            "upcoming": ledger.upcoming(today, int(settings["upcoming_days"])),
        }

    # --------------------------------------------------------- notifications

    @app.get("/api/notify")
    def notify_status():
        cfg = notify.config()
        return {"channels": notify.channels(cfg), "time": cfg["time"]}

    @app.post("/api/notify/test")
    def notify_test(today: Optional[date] = None):
        if not notify.channels(notify.config()):
            raise HTTPException(400, "No notification channel is configured")
        return notify.send_digest(db_path, _today(today), force=True)

    # ---------------------------------------------------------------- backup

    @app.get("/api/export")
    def export(conn=Depends(get_conn)):
        return {
            "app": "budget",
            "version": 1,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "settings": {k: v for k, v in db.get_settings(conn).items() if k != "last_digest"},
            "accounts": [dict(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")],
            "entries": [dict(r) for r in conn.execute("SELECT * FROM entries ORDER BY id")],
            "occurrences": [dict(r) for r in conn.execute("SELECT * FROM occurrences")],
        }

    @app.post("/api/import")
    def import_backup(data: dict, conn=Depends(get_conn)):
        if data.get("app") != "budget" or not isinstance(data.get("accounts"), list):
            raise HTTPException(400, "This file is not a Budget backup")
        tables = (
            ("accounts", ("id", *ACCOUNT_COLS)),
            ("entries", ("id", *ENTRY_COLS, "created_on")),
            ("occurrences", OCC_COLS),
        )
        try:
            for table, _ in reversed(tables):
                conn.execute(f"DELETE FROM {table}")
            for table, cols in tables:
                for item in data.get(table, []):
                    conn.execute(
                        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                        [item.get(c) for c in cols],
                    )
            for key, value in (data.get("settings") or {}).items():
                if key in db.DEFAULT_SETTINGS:
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()
        except (sqlite3.Error, AttributeError, TypeError) as exc:
            conn.rollback()
            raise HTTPException(400, f"Could not import backup: {exc}") from exc
        return {
            "accounts": len(data.get("accounts", [])),
            "entries": len(data.get("entries", [])),
        }

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_not_found(path: str):
        raise HTTPException(404, "Not found")

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


