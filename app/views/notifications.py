from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from app.db import SupabaseError
from app.deps import AppContext, require_group
from app.templating import page_context, templates

router = APIRouter(tags=["notifications"])


@router.get("/notifications")
def notifications(request: Request, ctx: AppContext = Depends(require_group)):
    try:
        items = ctx.db.select(
            "notifications",
            filters={"user_id": f"eq.{ctx.user_id}", "group_id": f"eq.{ctx.group_id}"},
            order="created_at.desc",
            limit=80,
        )
    except SupabaseError:
        items = []
    return templates.TemplateResponse(
        request,
        "pages/notifications.html",
        page_context(
            request,
            ctx,
            "notifications",
            "Notifications",
            "Race reminders, PRs, and badges",
            notifications=items,
        ),
    )


@router.post("/notifications/{notification_id}/read")
def mark_read(notification_id: str, ctx: AppContext = Depends(require_group)):
    try:
        ctx.db.update("notifications", {"id": f"eq.{notification_id}", "user_id": f"eq.{ctx.user_id}"}, {"is_read": True})
    except SupabaseError:
        pass
    return RedirectResponse("/notifications", status_code=303)


@router.post("/notifications/read-all")
def mark_all_read(ctx: AppContext = Depends(require_group)):
    try:
        ctx.db.update(
            "notifications",
            {"user_id": f"eq.{ctx.user_id}", "group_id": f"eq.{ctx.group_id}", "is_read": "eq.false"},
            {"is_read": True},
        )
    except SupabaseError:
        pass
    return RedirectResponse("/notifications", status_code=303)
