from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import get_settings
from app.views import admin, auth, certificates, community, dashboard, leaderboard, notifications, profile, races, results, runners

STATIC_DIR = Path(__file__).resolve().parent / "static"


class RefreshCookieMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        ctx = getattr(request.state, "ctx", None)
        if ctx and ctx.session.refreshed:
            settings = ctx.settings
            response.set_cookie(
                settings.access_cookie,
                ctx.session.refreshed["access"],
                httponly=True,
                samesite="lax",
                secure=settings.session_cookie_secure,
                max_age=60 * 60,
            )
            response.set_cookie(
                settings.refresh_cookie,
                ctx.session.refreshed["refresh"],
                httponly=True,
                samesite="lax",
                secure=settings.session_cookie_secure,
                max_age=60 * 60 * 24 * 14,
            )
        return response


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="PacePack", version="1.3.0", docs_url=None if not settings.is_dev else "/docs")
    app.add_middleware(RefreshCookieMiddleware)
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    for module in (auth, dashboard, leaderboard, races, results, certificates, runners, profile, community, notifications, admin):
        app.include_router(module.router)

    @app.get("/health")
    def health():
        return {"ok": True, "configured": settings.configured}

    @app.get("/manifest.webmanifest")
    def manifest():
        return RedirectResponse("/static/manifest.webmanifest")

    @app.get("/sw.js")
    def service_worker():
        return RedirectResponse("/static/sw.js")

    @app.exception_handler(StarletteHTTPException)
    async def redirect_auth(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 303 and exc.headers and exc.headers.get("Location"):
            return RedirectResponse(exc.headers["Location"], status_code=303)
        return await http_exception_handler(request, exc)

    return app


app = create_app()
