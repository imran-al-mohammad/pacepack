from fastapi import APIRouter, Depends, Request

from app.deps import AppContext, require_group
from app.services.analytics_service import dashboard_summary
from app.templating import page_context, templates

router = APIRouter(tags=["dashboard"])


@router.get("/")
def dashboard(request: Request, ctx: AppContext = Depends(require_group)):
    runners = ctx.rows("runners")
    races = ctx.rows("marathons", order="race_date.asc")
    registrations = ctx.rows("registrations")
    data = dashboard_summary(runners, races, registrations, ctx.team_count)
    return templates.TemplateResponse(
        request,
        "pages/dashboard.html",
        page_context(request, ctx, "dashboard", "Dashboard", "Live overview of races and results", **data),
    )
