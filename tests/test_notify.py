import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

from app import notify


def test_digest_lists_actions_and_is_sent_to_ntfy(client, checking, savings, tmp_path, monkeypatch):
    today = date.today()
    soon = (today + timedelta(days=2)).isoformat()
    client.post("/api/entries", json={"name": "Visa", "kind": "debit", "account_id": checking["id"],
                                      "variable": True, "start_date": soon, "frequency": "month"})
    client.post("/api/entries", json={"name": "Rent", "kind": "debit", "account_id": checking["id"],
                                      "amount": 150000, "start_date": soon})

    received = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received["title"] = self.headers["Title"]
            received["body"] = self.rfile.read(int(self.headers["Content-Length"])).decode()
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    monkeypatch.setenv("NTFY_URL", f"http://127.0.0.1:{server.server_port}/budget")

    result = notify.send_digest(str(tmp_path / "test.db"), today)
    server.server_close()
    assert result["sent"] is True, result
    assert received["title"] == "Budget: 3 things need attention"
    lines = received["body"].splitlines()
    assert lines[0].startswith("- LOW BALANCE: Checking drops to -$500.00")
    assert "Move $500.00 from Savings" in lines[0]
    assert any("Visa - amount needed" in line for line in lines)
    assert any("Rent - $1,500.00 (Checking)" in line for line in lines)


def test_nothing_sent_when_all_clear(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NTFY_URL", "http://127.0.0.1:9/never-called")
    result = notify.send_digest(str(tmp_path / "test.db"), date.today())
    assert result == {"sent": False, "reason": "nothing needs attention", "results": {}}
