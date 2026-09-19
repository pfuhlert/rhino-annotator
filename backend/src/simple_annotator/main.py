from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from simple_annotator import auth, jobs, patches
from simple_annotator.db import init_db


def create_app() -> FastAPI:
    init_db()
    app = FastAPI(title="simple-annotator")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(auth.router)
    app.include_router(auth.me_router)
    app.include_router(jobs.router)
    app.include_router(patches.router)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    return app


app = create_app()
