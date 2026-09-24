import fcntl
import json
import logging
import threading
import time

from sqlalchemy import select, update

from simple_annotator.annotations import Changes, Edit, ai_element_id, apply_changes, lock
from simple_annotator.config import AI_MODEL, sqlite_path
from simple_annotator.db import init_db, retry_sqlite_busy, session_factory
from simple_annotator.models import AiEmbedding, AiTask, AiWorker

log = logging.getLogger(__name__)


@retry_sqlite_busy
def claim(table=AiTask) -> tuple[str, dict] | None:
    with session_factory()() as db:
        task_id = db.scalar(
            select(table.id).where(table.status == "queued").order_by(table.created).limit(1)
        )
        if not task_id:
            return None
        task = db.execute(
            update(table)
            .where(table.id == task_id, table.status == "queued")
            .values(status="running")
            .returning(table.id, table.input)
        ).first()
        db.commit()
        return (task.id, json.loads(task.input)) if task else None


@retry_sqlite_busy
def complete(task_id: str, polygon: dict, elapsed_ms: int) -> None:
    with session_factory()() as db:
        lock(db)
        task = db.get(AiTask, task_id)
        if task.status != "running":
            return
        el = Edit(id=ai_element_id(task.id), jobId=task.job_id, type="polygon", **polygon)
        apply_changes(db, task.user_id, task.patch_id, Changes(upsert=[el]))
        task.status = "done"
        task.finished = time.time()
        task.elapsed_ms = elapsed_ms
        db.commit()


@retry_sqlite_busy
def fail(task_id: str, error: str, table=AiTask) -> None:
    with session_factory()() as db:
        db.execute(
            update(table)
            .where(table.id == task_id, table.status == "running")
            .values(status="failed", error=error)
        )
        db.commit()


@retry_sqlite_busy
def resume() -> None:
    with session_factory()() as db:
        for table in (AiTask, AiEmbedding):
            db.execute(update(table).where(table.status == "running").values(status="queued"))
        db.commit()


def process_next(segmenters: dict) -> bool:
    table = AiTask
    item = claim()
    if item is None:
        table = AiEmbedding
        item = claim(table)
    if item is None:
        return False
    task_id, request = item
    start = time.perf_counter()
    try:
        segmenter = segmenters[request["model"]]
        if table is AiEmbedding:
            # prepare persists the tensor and marks this row ready before returning.
            segmenter.prepare(request)
        else:
            polygon = segmenter.predict(request)
            complete(task_id, polygon, round((time.perf_counter() - start) * 1000))
        log.info(
            "%s %s completed in %d ms",
            table.__tablename__,
            task_id,
            round((time.perf_counter() - start) * 1000),
        )
    except Exception as exc:
        log.exception("%s %s failed", table.__tablename__, task_id)
        fail(
            task_id,
            str(exc)
            if isinstance(exc, ValueError)
            else "Segmentation failed. Retry or use the brush.",
            table,
        )
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    init_db()
    with open(str(sqlite_path()) + ".worker.lock", "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("An AI worker is already running for this database")
        ready = threading.Event()
        stopped = threading.Event()

        def heartbeat():
            while not stopped.is_set():
                try:
                    with session_factory()() as db:
                        db.merge(
                            AiWorker(
                                id=1,
                                updated=time.time(),
                                status="ready" if ready.is_set() else "loading",
                            )
                        )
                        db.commit()
                except Exception:
                    log.exception("AI heartbeat failed")
                stopped.wait(2)

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        try:
            from simple_annotator.segmenter import MicroSam

            segmenters = {AI_MODEL: MicroSam()}
            ready.set()
            resume()
            log.info("AI worker ready")
            while True:
                if not process_next(segmenters):
                    time.sleep(0.08)
        finally:
            stopped.set()
            thread.join()
            with session_factory()() as db:
                worker = db.get(AiWorker, 1)
                if worker:
                    worker.updated = 0
                    db.commit()


if __name__ == "__main__":
    main()
