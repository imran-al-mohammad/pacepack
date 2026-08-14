from fastapi import APIRouter, Depends, Request

from app.deps import AppContext, require_group
from app.services.time_utils import is_past_race
from app.templating import page_context, templates

router = APIRouter(tags=["races"])


@router.get("/races")
def races(request: Request, ctx: AppContext = Depends(require_group)):
    race_rows = ctx.rows("marathons", order="race_date.asc")
    registrations = ctx.rows("registrations")
    counts: dict[str, int] = {}
    for row in registrations:
        mid = row.get("marathon_id")
        if mid:
            counts[mid] = counts.get(mid, 0) + 1
    upcoming = [race for race in race_rows if not is_past_race(race)]
    past = list(reversed([race for race in race_rows if is_past_race(race)]))
    return templates.TemplateResponse(
        request,
        "pages/races.html",
        page_context(
            request,
            ctx,
            "races",
            "Marathons",
            "Races the group is tracking",
            upcoming=upcoming,
            past=past,
            counts=counts,
        ),
    )
