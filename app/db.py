"""SQLite storage. All money values are stored as integer cents."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = os.environ.get("BUDGET_DB", str(Path("data") / "budget.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    type            TEXT    NOT NULL DEFAULT 'checking',
    opening_balance INTEGER NOT NULL DEFAULT 0,
    opening_date    TEXT    NOT NULL,
    min_balance     INTEGER,
    color           TEXT,
    notes           TEXT
);

-- An entry is a one-time or recurring credit, debit or transfer.
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('credit', 'debit', 'transfer')),
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    to_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    amount        INTEGER,
    variable      INTEGER NOT NULL DEFAULT 0,
    estimate      INTEGER,
    frequency     TEXT    NOT NULL DEFAULT 'once'
                  CHECK (frequency IN ('once', 'day', 'week', 'month', 'year')),
    interval      INTEGER NOT NULL DEFAULT 1,
    start_date    TEXT    NOT NULL,
    end_date      TEXT,
    autopay       INTEGER NOT NULL DEFAULT 0,
    remind_days   INTEGER NOT NULL DEFAULT 5,
    category      TEXT,
    notes         TEXT,
    created_on    TEXT    NOT NULL
);

-- Per-occurrence changes to an entry, keyed by the originally scheduled date.
CREATE TABLE IF NOT EXISTS occurrences (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    occ_date TEXT    NOT NULL,
    date     TEXT,
    amount   INTEGER,
    status   TEXT    NOT NULL DEFAULT 'scheduled'
             CHECK (status IN ('scheduled', 'paid', 'skipped')),
    note     TEXT,
    PRIMARY KEY (entry_id, occ_date)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_account ON entries(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_to_account ON entries(to_account_id);
"""

DEFAULT_SETTINGS = {
    "currency": "USD",
    "week_start": "0",  # 0 = Sunday, 1 = Monday
    "horizon_days": "45",  # how far ahead to look for low balances
    "upcoming_days": "14",  # "coming up" list window
}


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or DEFAULT_DB_PATH
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    # FastAPI may open, use and close a request's connection on different
    # worker threads; each connection still serves only one request at a time.
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str | None = None) -> None:
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            DEFAULT_SETTINGS.items(),
        )
        conn.commit()
    finally:
        conn.close()


def get_settings(conn: sqlite3.Connection) -> dict[str, str]:
    settings = dict(DEFAULT_SETTINGS)
    settings.update({r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")})
    return settings
