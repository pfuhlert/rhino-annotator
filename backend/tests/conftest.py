import sqlite3
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RHINO_ANNOTATOR_SQLITE", str(tmp_path / "t.sqlite"))
    monkeypatch.setenv("GIRDER_TOKEN", "")
    from rhino_annotator import db

    db.reset_engine()
    from rhino_annotator.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    db.reset_engine()


@pytest.fixture
def auth(client: TestClient):
    client.post("/auth/register", json={"username": "ada", "password": "secret"})
    return client


@pytest.fixture
def three_images(monkeypatch):
    # Without Girder every image is a placeholder; three of them give Next somewhere to go.
    from rhino_annotator import images

    items = [{"_id": i, "name": f"{i}.png"} for i in "abc"]
    monkeypatch.setattr(images, "folder_listing", lambda _db, _id: items)


@pytest.fixture
def busy_db(client):
    from sqlalchemy import event

    from rhino_annotator.config import sqlite_path
    from rhino_annotator.db import get_engine

    engine = get_engine()
    blocked = Event()

    def timeout(connection, *_):
        connection.execute("PRAGMA busy_timeout=20")

    def on_error(context):
        code = getattr(context.original_exception, "sqlite_errorcode", 0) & 0xFF
        if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            blocked.set()

    event.listen(engine, "checkout", timeout)
    event.listen(engine, "handle_error", on_error)
    writer = sqlite3.connect(sqlite_path(), check_same_thread=False)
    try:
        yield writer, blocked
    finally:
        writer.close()
        event.remove(engine, "checkout", timeout)
        event.remove(engine, "handle_error", on_error)
