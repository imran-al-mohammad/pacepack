from fastapi import APIRouter, Depends, Request

from app.deps import AppContext, require_group
from app.services.time_utils import is_finish
from app.templating import page_context, templates

router = APIRouter(tags=["runners"])


@router.get("/runners")
def runners(request: Request, ctx: AppContext = Depends(require_group)):
    runner_rows = sorted(ctx.rows("runners"), key=lambda row: (row.get("name") or "").lower())
    registrations = ctx.rows("registrations")
    stats = {}
    for row in registrations:
        bucket = stats.setdefault(row.get("runner_id"), {"entries": 0, "finishes": 0})
        bucket["entries"] += 1
        if is_finish(row):
            bucket["finishes"] += 1
    return templates.TemplateResponse(
        request,
        "pages/runners.html",
        page_context(
            request,
            ctx,
            "runners",
            "Runners",
            "People in the running roster",
            runners=runner_rows,
            stats=stats,
        ),
    )
