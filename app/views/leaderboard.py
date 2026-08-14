from fastapi import APIRouter, Depends, Request

from app.deps import AppContext, require_group
from app.services.analytics_service import activity_leaderboard, fastest_runners
from app.templating import page_context, templates

router = APIRouter(tags=["leaderboard"])


@router.get("/leaderboard")
def leaderboard(request: Request, ctx: AppContext = Depends(require_group)):
    runners = ctx.rows("runners")
    races = ctx.rows("marathons")
    registrations = ctx.rows("registrations")
    return templates.TemplateResponse(
        request,
        "pages/leaderboard.html",
        page_context(
            request,
            ctx,
            "leaderboard",
            "Leaderboard",
            "Full rankings for speed and contribution",
            fastest=fastest_runners(runners, races, registrations),
            activity=activity_leaderboard(runners, registrations),
        ),
    )
