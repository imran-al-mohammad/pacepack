from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from app.config import Settings, get_settings
from app.db import SupabaseError, user_client
from app.deps import AppContext, get_context, load_session
from app.templating import templates

router = APIRouter(tags=["auth"])


def _set_session_cookies(response: RedirectResponse, tokens: dict, settings: Settings) -> None:
    secure = settings.session_cookie_secure
    response.set_cookie(settings.access_cookie, tokens["access_token"], httponly=True, samesite="lax", secure=secure, max_age=60 * 60)
    if tokens.get("refresh_token"):
        response.set_cookie(settings.refresh_cookie, tokens["refresh_token"], httponly=True, samesite="lax", secure=secure, max_age=60 * 60 * 24 * 14)


def _clear_cookies(response: RedirectResponse, settings: Settings) -> None:
    response.delete_cookie(settings.access_cookie)
    response.delete_cookie(settings.refresh_cookie)


@router.get("/login")
def login_page(request: Request, session=Depends(load_session), settings: Settings = Depends(get_settings)):
    if session:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "request": request,
            "error": request.query_params.get("error"),
            "configured": settings.configured,
        },
    )


@router.post("/login")
def login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    settings: Settings = Depends(get_settings),
):
    try:
        tokens = user_client().sign_in(email.strip(), password)
    except SupabaseError as exc:
        return templates.TemplateResponse(
            request,
            "login.html",
            {"request": request, "error": str(exc) or "Could not sign in", "configured": settings.configured, "email": email},
            status_code=400,
        )
    if not tokens.get("access_token"):
        return templates.TemplateResponse(
            request,
            "login.html",
            {"request": request, "error": "Sign-in did not return a session", "configured": settings.configured, "email": email},
            status_code=400,
        )
    response = RedirectResponse("/", status_code=303)
    _set_session_cookies(response, tokens, settings)
    return response


@router.post("/logout")
def logout(request: Request, settings: Settings = Depends(get_settings)):
    access = request.cookies.get(settings.access_cookie)
    if access:
        try:
            user_client(access).sign_out()
        except SupabaseError:
            pass
    response = RedirectResponse("/login", status_code=303)
    _clear_cookies(response, settings)
    return response


@router.get("/onboarding")
def onboarding(request: Request, ctx: AppContext = Depends(get_context)):
    if ctx.group:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request,
        "onboarding.html",
        {
            "request": request,
            "ctx": ctx,
            "error": request.query_params.get("error"),
            "can_create": (ctx.profile.get("user_type") == "admin"),
        },
    )


@router.post("/onboarding/join")
def join_group(code: str = Form(...), ctx: AppContext = Depends(get_context)):
    try:
        ctx.db.rpc("join_group", {"p_code": code.strip().upper()})
    except SupabaseError as exc:
        return RedirectResponse(f"/onboarding?error={exc}", status_code=303)
    return RedirectResponse("/", status_code=303)


@router.post("/onboarding/create")
def create_group(name: str = Form(...), ctx: AppContext = Depends(get_context)):
    try:
        ctx.db.rpc("create_group", {"p_name": name.strip()})
    except SupabaseError as exc:
        return RedirectResponse(f"/onboarding?error={exc}", status_code=303)
    return RedirectResponse("/", status_code=303)
