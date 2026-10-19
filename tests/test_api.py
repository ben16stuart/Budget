from datetime import date


def entry(client, **kw):
    body = {"name": "Thing", "kind": "debit", "frequency": "once", "start_date": "2026-10-10", "amount": 1000}
    body.update(kw)
    r = client.post("/api/entries", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def cal(client, start, end):
    r = client.get("/api/calendar", params={"start": start, "end": end})
    assert r.status_code == 200, r.text
    return r.json()


def test_balances_follow_credits_debits_and_transfers(client, checking, savings):
    entry(client, name="Pay", kind="credit", account_id=checking["id"], amount=250000,
          frequency="week", interval=2, start_date="2026-10-02")
    entry(client, name="Rent", account_id=checking["id"], amount=150000,
          frequency="month", start_date="2026-10-05")
    entry(client, name="To savings", kind="transfer", account_id=checking["id"],
          to_account_id=savings["id"], amount=20000, start_date="2026-10-20")
    data = cal(client, "2026-09-30", "2026-10-31")
    c, s = str(checking["id"]), str(savings["id"])
    assert data["balances"]["2026-09-30"][c] is None  # before opening date
    assert data["balances"]["2026-10-01"][c] == 100000
    assert data["balances"]["2026-10-02"][c] == 350000
    assert data["balances"]["2026-10-05"][c] == 200000
    assert data["balances"]["2026-10-16"][c] == 450000
    assert data["balances"]["2026-10-20"][c] == 430000
    assert data["balances"]["2026-10-20"][s] == 520000
    # Window starting later still carries earlier activity forward.
    later = cal(client, "2026-10-21", "2026-10-21")
    assert later["balances"]["2026-10-21"][c] == 430000


def test_variable_amounts_use_estimate_then_last_actual(client, checking):
    e = entry(client, name="Electric", account_id=checking["id"], amount=None, variable=True,
              frequency="month", start_date="2026-10-15")
    occs = cal(client, "2026-10-01", "2026-12-31")["occurrences"]
    assert [o["amount_known"] for o in occs] == [False, False, False]
    assert occs[0]["amount"] == 0

    r = client.patch(f"/api/occurrences/{e['id']}/2026-10-15", json={"amount": 12345})
    assert r.status_code == 200, r.text
    assert r.json()["amount_known"] is True
    occs = cal(client, "2026-10-01", "2026-12-31")["occurrences"]
    assert [o["amount"] for o in occs] == [12345, 12345, 12345]
    assert [o["amount_known"] for o in occs] == [True, False, False]


def test_skip_move_and_reset_occurrence(client, checking):
    e = entry(client, name="Gym", account_id=checking["id"], amount=5000,
              frequency="month", start_date="2026-10-28")
    r = client.patch(f"/api/occurrences/{e['id']}/2026-10-28", json={"date": "2026-11-02"})
    assert r.json()["date"] == "2026-11-02" and r.json()["moved"]
    assert cal(client, "2026-10-01", "2026-10-31")["occurrences"] == []
    nov = cal(client, "2026-11-01", "2026-11-30")["occurrences"]
    assert [(o["occ_date"], o["date"]) for o in nov] == [("2026-10-28", "2026-11-02"), ("2026-11-28", "2026-11-28")]

    client.patch(f"/api/occurrences/{e['id']}/2026-11-28", json={"status": "skipped"})
    data = cal(client, "2026-11-01", "2026-11-30")
    assert data["balances"]["2026-11-30"][str(checking["id"])] == 95000

    assert client.patch(f"/api/occurrences/{e['id']}/2026-11-27", json={"status": "paid"}).status_code == 400
    client.delete(f"/api/occurrences/{e['id']}/2026-10-28")
    assert len(cal(client, "2026-10-01", "2026-10-31")["occurrences"]) == 1


def test_action_items(client, checking):
    today = date.today()
    t = lambda days: date.fromordinal(today.toordinal() + days).isoformat()
    visa = entry(client, name="Visa", account_id=checking["id"], amount=None, variable=True,
                 start_date=t(3), remind_days=5)
    entry(client, name="Rent", account_id=checking["id"], amount=1000, start_date=t(-2))
    entry(client, name="Netflix", account_id=checking["id"], amount=1500, autopay=True, start_date=t(1))
    entry(client, name="Far off", account_id=checking["id"], amount=1500, start_date=t(20))
    entry(client, name="Pay", kind="credit", account_id=checking["id"], amount=1500, start_date=t(1))

    items = client.get("/api/alerts", params={"today": today.isoformat()}).json()["action_items"]
    by_name = {i["name"]: i for i in items}
    assert set(by_name) == {"Visa"}, by_name  # Rent predates creation; Netflix autopay; Pay is income
    assert by_name["Visa"]["reasons"] == ["needs_amount", "due_soon"]

    client.patch(f"/api/occurrences/{visa['id']}/{t(3)}", json={"amount": 40000, "status": "paid"})
    items = client.get("/api/alerts", params={"today": today.isoformat()}).json()["action_items"]
    assert items == []

    # Viewed from a later date, Visa (paid) stays quiet and an unpaid bill is overdue.
    later = date.fromordinal(today.toordinal() + 25).isoformat()
    items = client.get("/api/alerts", params={"today": later}).json()["action_items"]
    assert [(i["name"], i["reasons"]) for i in items] == [("Far off", ["overdue"])]


def test_low_balance_alert_suggests_transfer(client, checking, savings):
    entry(client, name="Rent", account_id=checking["id"], amount=150000,
          frequency="month", start_date="2026-11-01")
    alerts = client.get("/api/alerts", params={"today": "2026-10-20"}).json()["balance_alerts"]
    assert len(alerts) == 1
    a = alerts[0]
    assert a["account_id"] == checking["id"]
    assert a["first_breach_date"] == "2026-11-01"
    # No income: the dip lasts the whole look-ahead window, through December's rent too.
    assert (a["lowest_date"], a["shortfall"], a["recovers_on"]) == ("2026-12-01", 200000, None)
    assert a["triggers"] == ["Rent"]
    assert a["suggestion"]["from_account_id"] == savings["id"]
    assert a["suggestion"]["amount"] == 200000
    assert a["suggestion"]["by_date"] == "2026-10-31"

    # A paycheck ends the dip, so only the first rent needs covering.
    entry(client, name="Pay", kind="credit", account_id=checking["id"], amount=300000,
          frequency="month", start_date="2026-11-15")
    a = client.get("/api/alerts", params={"today": "2026-10-20"}).json()["balance_alerts"][0]
    assert (a["lowest_date"], a["shortfall"], a["recovers_on"]) == ("2026-11-01", 50000, "2026-11-15")

    entry(client, name="Top up", kind="transfer", account_id=savings["id"], to_account_id=checking["id"],
          amount=50000, start_date="2026-10-30")
    assert client.get("/api/alerts", params={"today": "2026-10-20"}).json()["balance_alerts"] == []


def test_edit_this_and_future_splits_series(client, checking):
    e = entry(client, name="Rent", account_id=checking["id"], amount=100000,
              frequency="month", start_date="2026-08-01")
    client.patch(f"/api/occurrences/{e['id']}/2026-12-01", json={"status": "paid"})
    body = {**{k: e[k] for k in ("name", "kind", "account_id", "frequency", "interval", "remind_days")},
            "amount": 120000, "start_date": "2026-11-01", "effective_from": "2026-11-01"}
    r = client.put(f"/api/entries/{e['id']}", json=body)
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["id"] != e["id"]
    occs = cal(client, "2026-08-01", "2026-12-31")["occurrences"]
    assert [(o["date"], o["amount"]) for o in occs] == [
        ("2026-08-01", 100000), ("2026-09-01", 100000), ("2026-10-01", 100000),
        ("2026-11-01", 120000), ("2026-12-01", 120000),
    ]
    assert occs[-1]["status"] == "paid" and occs[-1]["entry_id"] == new["id"]


def test_validation_errors(client, checking):
    r = client.post("/api/entries", json={"name": "X", "kind": "transfer", "account_id": checking["id"],
                                          "amount": 5, "start_date": "2026-10-01"})
    assert r.status_code == 422
    r = client.post("/api/entries", json={"name": "X", "kind": "debit", "account_id": 999,
                                          "amount": 5, "start_date": "2026-10-01"})
    assert r.status_code == 400
    r = client.post("/api/entries", json={"name": "X", "kind": "debit", "account_id": checking["id"],
                                          "start_date": "2026-10-01"})
    assert r.status_code == 422


def test_export_import_roundtrip(client, checking, savings):
    entry(client, name="Rent", account_id=checking["id"], amount=150000, frequency="month",
          start_date="2026-11-01")
    backup = client.get("/api/export").json()
    client.delete(f"/api/accounts/{checking['id']}")
    assert len(client.get("/api/entries").json()) == 0
    r = client.post("/api/import", json=backup)
    assert r.status_code == 200, r.text
    assert [e["name"] for e in client.get("/api/entries").json()] == ["Rent"]
    assert len(client.get("/api/accounts").json()) == 2


def test_static_and_unknown_api(client):
    assert client.get("/api/nope").status_code == 404
