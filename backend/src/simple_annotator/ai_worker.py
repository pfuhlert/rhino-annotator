import fcntl
import json
import logging
import threading
import time

from sqlalchemy import select, update

from simple_annotator.annotations import Changes, Edit, ai_element_id, apply_changes, lock
from simple_annotator.config import sqlite_path
from simple_annotator.db import init_db, session_factory
from simple_annotator.models import AiTask, AiWorker

log = logging.getLogger(__name__)


def claim() -> tuple[str, dict] | None:
    with session_factory()() as db:
        task_id = db.scalar(
            select(AiTask.id).where(AiTask.status == "queued").order_by(AiTask.created).limit(1)
        )
        if not task_id:
            return None
        task = db.execute(
            update(AiTask)
            .where(AiTask.id == task_id, AiTask.status == "queued")
            .values(status="running")
            .returning(AiTask.id, AiTask.input)
        ).first()
        db.commit()
        return (task.id, json.loads(task.input)) if task else None


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


def fail(task_id: str, error: str) -> None:
    with session_factory()() as db:
        db.execute(
            update(AiTask)
            .where(AiTask.id == task_id, AiTask.status == "running")
            .values(status="failed", error=error)
        )
        db.commit()


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

            segmenters = {"microsam-em-1.2": MicroSam()}
            ready.set()
            with session_factory()() as db:
                db.execute(update(AiTask).where(AiTask.status == "running").values(status="queued"))
                db.commit()
            log.info("AI worker ready")
            while True:
                item = claim()
                if item is None:
                    time.sleep(0.08)
                    continue
                task_id, request = item
                start = time.perf_counter()
                try:
                    segmenter = segmenters[request["model"]]
                    polygon = segmenter.predict(request)
                    elapsed = round((time.perf_counter() - start) * 1000)
                    complete(task_id, polygon, elapsed)
                    log.info("Task %s completed in %d ms", task_id, elapsed)
                except Exception as exc:
                    log.exception("AI task %s failed", task_id)
                    fail(
                        task_id,
                        str(exc)
                        if isinstance(exc, ValueError)
                        else "Segmentation failed. Retry or use the brush.",
                    )
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
