import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"), start_scheduler=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def checking(client):
    r = client.post(
        "/api/accounts",
        json={"name": "Checking", "type": "checking", "opening_balance": 100000,
              "opening_date": "2026-10-01", "min_balance": 0},
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def savings(client):
    r = client.post(
        "/api/accounts",
        json={"name": "Savings", "type": "savings", "opening_balance": 500000,
              "opening_date": "2026-10-01", "min_balance": 0},
    )
    assert r.status_code == 201, r.text
    return r.json()
