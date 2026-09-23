import multiprocessing
import os

from sqlalchemy import select

from simple_annotator import db
from simple_annotator.models import Job


def _init_together(path, barrier):
    os.environ["SIMPLE_ANNOTATOR_SQLITE"] = path
    db.reset_engine()
    barrier.wait(timeout=10)
    db.init_db()
    db.reset_engine()


def test_api_and_worker_can_initialize_a_fresh_database_together(tmp_path, monkeypatch):
    path = str(tmp_path / "startup.sqlite")
    ctx = multiprocessing.get_context("spawn")
    barrier = ctx.Barrier(4)
    processes = [ctx.Process(target=_init_together, args=(path, barrier)) for _ in range(4)]
    try:
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=20)
            assert process.exitcode == 0
        monkeypatch.setenv("SIMPLE_ANNOTATOR_SQLITE", path)
        db.reset_engine()
        with db.session_factory()() as session:
            assert set(session.scalars(select(Job.name))) == {
                name for name, _ in (*db.SEED_JOBS, *db.ELMI_JOBS)
            }
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join()
        db.reset_engine()
