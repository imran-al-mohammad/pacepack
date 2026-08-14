from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from app.deps import AppContext
from app.services.time_utils import (
    avatar_color,
    days_until,
    format_date,
    format_pace,
    format_time,
    initials,
    month_short_year,
    status_label,
)

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates.env.filters["date"] = format_date
templates.env.filters["when"] = format_date
templates.env.filters["time"] = format_time
templates.env.filters["pace"] = format_pace
templates.env.filters["month"] = month_short_year
templates.env.filters["status"] = status_label
templates.env.globals["initials"] = initials
templates.env.globals["avatar_color"] = avatar_color
templates.env.globals["days_until"] = days_until

NAV_ITEMS = [
    {"key": "dashboard", "href": "/", "label": "Dashboard", "icon": "dashboard"},
    {"key": "leaderboard", "href": "/leaderboard", "label": "Leaderboard", "icon": "leaderboard"},
    {"key": "races", "href": "/races", "label": "Marathons", "icon": "marathons"},
    {"key": "results", "href": "/results", "label": "Results & Times", "icon": "results"},
    {"key": "runners", "href": "/runners", "label": "Runners", "icon": "members"},
    {"key": "community", "href": "/community", "label": "Community", "icon": "community"},
    {"key": "notifications", "href": "/notifications", "label": "Notifications", "icon": "notifications"},
    {"key": "profile", "href": "/profile", "label": "My Profile", "icon": "profile"},
    {"key": "admin", "href": "/admin", "label": "Admin", "icon": "team", "min_role": "moderator"},
]


def page_context(request: Request, ctx: AppContext, view: str, title: str, desc: str, **extra: Any) -> dict[str, Any]:
    nav = []
    for item in NAV_ITEMS:
        if item.get("min_role") and not ctx.has_min_role(item["min_role"]):
            continue
        nav.append({**item, "active": item["key"] == view})
    display_name = ctx.profile.get("display_name") or ctx.user.get("email") or "Runner"
    return {
        "request": request,
        "ctx": ctx,
        "view": view,
        "title": title,
        "desc": desc,
        "nav": nav,
        "display_name": display_name,
        "group_name": (ctx.group or {}).get("name") or "PacePack",
        "flash": request.query_params.get("flash"),
        "error": request.query_params.get("error") or extra.get("form_error"),
        **extra,
    }
