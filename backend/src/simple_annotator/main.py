import logging

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from simple_annotator import ai, auth, export, images, patches, projects
from simple_annotator.db import init_db
from simple_annotator.slides import UnreadableImage

log = logging.getLogger(__name__)


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
    app.include_router(ai.router)
    app.include_router(patches.router)
    app.include_router(images.router)
    app.include_router(export.router)
    app.include_router(projects.router)

    @app.exception_handler(httpx.HTTPError)
    def image_server_error(_request: Request, exc: httpx.HTTPError) -> JSONResponse:
        log.warning("Girder request failed: %s", exc)
        reason = (
            f"returned an error ({exc.response.status_code})"
            if isinstance(exc, httpx.HTTPStatusError)
            else "could not be reached"
        )
        return JSONResponse(
            {"detail": f"The image server (Girder) {reason}. Please try again later."},
            status_code=502,
        )

    @app.exception_handler(UnreadableImage)
    def unreadable_image(_request: Request, exc: UnreadableImage) -> JSONResponse:
        detail = f" Girder says: {exc}" if str(exc) else ""
        return JSONResponse(
            {"detail": f"The image server (Girder) cannot read this image.{detail}"},
            status_code=502,
        )

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    return app


app = create_app()
