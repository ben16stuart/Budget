"""Optional daily digest of what needs attention, sent via ntfy and/or email.

Configured entirely with environment variables (see README). When nothing is
configured the scheduler never starts.
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
import threading
import urllib.request
from datetime import date, datetime, time
from email.message import EmailMessage

from . import db
from .ledger import Ledger

log = logging.getLogger("budget.notify")

SYMBOLS = {"USD": "$", "CAD": "$", "AUD": "$", "NZD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹"}


def config() -> dict:
    env = os.environ.get
    return {
        "ntfy_url": env("NTFY_URL", "").strip(),
        "ntfy_token": env("NTFY_TOKEN", "").strip(),
        "smtp_host": env("SMTP_HOST", "").strip(),
        "smtp_port": int(env("SMTP_PORT", "587") or 587),
        "smtp_user": env("SMTP_USER", "").strip(),
        "smtp_password": env("SMTP_PASSWORD", ""),
        "smtp_from": env("SMTP_FROM", "").strip(),
        "smtp_to": env("SMTP_TO", "").strip(),
        "smtp_starttls": env("SMTP_STARTTLS", "true").lower() not in ("0", "false", "no"),
        "time": env("NOTIFY_TIME", "08:00").strip(),
        "app_url": env("APP_URL", "").strip(),
    }


def channels(cfg: dict) -> list[str]:
    out = []
    if cfg["ntfy_url"]:
        out.append("ntfy")
    if cfg["smtp_host"] and cfg["smtp_to"]:
        out.append("email")
    return out


def fmt_money(cents: int, currency: str) -> str:
    sign = "-" if cents < 0 else ""
    amount = f"{abs(cents) / 100:,.2f}"
    symbol = SYMBOLS.get(currency)
    return f"{sign}{symbol}{amount}" if symbol else f"{sign}{amount} {currency}"


def fmt_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d:%a} {d:%b} {d.day}"


def build_digest(conn, today: date) -> tuple[str, str, bool]:
    """Returns (title, body, urgent). Body is empty when nothing needs attention."""
    settings = db.get_settings(conn)
    currency = settings["currency"]
    ledger = Ledger(conn)
    names = {a["id"]: a["name"] for a in ledger.accounts.values()}
    lines = []
    urgent = False

    for a in ledger.balance_alerts(today, int(settings["horizon_days"])):
        urgent = urgent or a["severity"] == "danger"
        line = (
            f"LOW BALANCE: {a['account_name']} drops to {fmt_money(a['lowest_balance'], currency)} "
            f"on {fmt_date(a['lowest_date'])} (below your {fmt_money(a['min_balance'], currency)} "
            f"minimum from {fmt_date(a['first_breach_date'])})."
        )
        s = a["suggestion"]
        if s:
            line += (
                f" Move {fmt_money(s['amount'], currency)} from {s['from_account_name']} "
                f"by {fmt_date(s['by_date'])}."
            )
        else:
            line += f" Add {fmt_money(a['shortfall'], currency)} by {fmt_date(a['by_date'])}."
        lines.append(line)

    for i in ledger.action_items(today):
        urgent = urgent or i["severity"] == "danger"
        account = names.get(i["account_id"], "?")
        amount = fmt_money(i["amount"], currency)
        if not i["amount_known"]:
            amount = f"amount needed (est. {amount})"
        when = fmt_date(i["date"])
        if "overdue" in i["reasons"]:
            prefix = f"OVERDUE since {when}"
        elif i["days_until"] == 0:
            prefix = "Due today"
        elif i["days_until"] == 1:
            prefix = "Due tomorrow"
        else:
            prefix = f"Due {when}"
        lines.append(f"{prefix}: {i['name']} - {amount} ({account})")

    if not lines:
        return "Budget: all clear", "", False
    noun = "thing needs" if len(lines) == 1 else "things need"
    return f"Budget: {len(lines)} {noun} attention", "\n".join(f"- {l}" for l in lines), urgent


def send_ntfy(cfg: dict, title: str, body: str, urgent: bool) -> None:
    headers = {
        # HTTP headers must be latin-1; titles are plain ASCII anyway.
        "Title": title.encode("ascii", "replace").decode(),
        "Priority": "high" if urgent else "default",
        "Tags": "moneybag",
    }
    if cfg["app_url"]:
        headers["Click"] = cfg["app_url"]
    if cfg["ntfy_token"]:
        headers["Authorization"] = f"Bearer {cfg['ntfy_token']}"
    req = urllib.request.Request(cfg["ntfy_url"], data=body.encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def send_email(cfg: dict, title: str, body: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = cfg["smtp_from"] or cfg["smtp_user"] or cfg["smtp_to"]
    msg["To"] = cfg["smtp_to"]
    text = body
    if cfg["app_url"]:
        text += f"\n\nOpen your budget: {cfg['app_url']}"
    msg.set_content(text)
    if cfg["smtp_port"] == 465:
        server = smtplib.SMTP_SSL(cfg["smtp_host"], 465, timeout=20, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"], timeout=20)
    with server:
        if cfg["smtp_port"] != 465 and cfg["smtp_starttls"]:
            server.starttls(context=ssl.create_default_context())
        if cfg["smtp_user"]:
            server.login(cfg["smtp_user"], cfg["smtp_password"])
        server.send_message(msg)


def send_digest(db_path: str | None, today: date | None = None, force: bool = False) -> dict:
    """Send the digest on every configured channel. Without force, an empty digest is not sent."""
    cfg = config()
    conn = db.connect(db_path)
    try:
        title, body, urgent = build_digest(conn, today or date.today())
    finally:
        conn.close()
    if not body:
        if not force:
            return {"sent": False, "reason": "nothing needs attention", "results": {}}
        body = "Nothing needs your attention right now. This is a test notification."
    results = {}
    for channel in channels(cfg):
        try:
            if channel == "ntfy":
                send_ntfy(cfg, title, body, urgent)
            else:
                send_email(cfg, title, body)
            results[channel] = "ok"
        except Exception as exc:  # noqa: BLE001 - report any delivery failure to the caller
            log.warning("digest via %s failed: %s", channel, exc)
            results[channel] = f"error: {exc}"
    return {"sent": any(r == "ok" for r in results.values()), "results": results, "title": title}


class DigestScheduler(threading.Thread):
    """Sends the digest once a day, at or after NOTIFY_TIME (container local time)."""

    def __init__(self, db_path: str | None):
        super().__init__(daemon=True, name="digest-scheduler")
        self.db_path = db_path
        self.stop_event = threading.Event()
        raw = config()["time"]
        try:
            hh, _, mm = raw.partition(":")
            self.at = time(int(hh), int(mm or 0))
        except ValueError:
            log.warning("NOTIFY_TIME %r is not HH:MM; using 08:00", raw)
            self.at = time(8, 0)

    def _last_sent(self) -> str | None:
        conn = db.connect(self.db_path)
        try:
            row = conn.execute("SELECT value FROM settings WHERE key = 'last_digest'").fetchone()
            return row["value"] if row else None
        finally:
            conn.close()

    def _mark_sent(self, day: str) -> None:
        conn = db.connect(self.db_path)
        try:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_digest', ?)", (day,))
            conn.commit()
        finally:
            conn.close()

    def run(self) -> None:
        log.info("daily digest enabled at %s via %s", self.at.strftime("%H:%M"), ", ".join(channels(config())))
        while not self.stop_event.is_set():
            now = datetime.now()
            today = now.date().isoformat()
            try:
                if now.time() >= self.at and self._last_sent() != today:
                    result = send_digest(self.db_path, now.date())
                    log.info("daily digest: %s", result)
                    self._mark_sent(today)
            except Exception:  # noqa: BLE001 - keep the scheduler alive
                log.exception("daily digest failed")
            self.stop_event.wait(60)

    def stop(self) -> None:
        self.stop_event.set()
