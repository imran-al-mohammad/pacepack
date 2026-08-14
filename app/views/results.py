from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse

from app.deps import AppContext, require_group, wants_htmx
from app.services import certificate_service, result_service
from app.services.certificate_service import CertificateError
from app.services.result_service import ResultError
from app.services.time_utils import STATUSES, is_logged_result, is_past_race
from app.templating import page_context, templates

router = APIRouter(tags=["results"])
PROFILE_TABS = ("results", "certificates")


def _race_options(ctx: AppContext) -> list[dict]:
    races = ctx.rows("marathons", order="race_date.desc")
    registrations = ctx.rows("registrations")
    options = []
    for race in races:
        count = sum(1 for row in registrations if row.get("marathon_id") == race.get("id"))
        logged = sum(1 for row in registrations if row.get("marathon_id") == race.get("id") and is_logged_result(row))
        options.append({**race, "entry_count": count, "logged_count": logged, "past": is_past_race(race)})
    return options


def _selected_race(options: list[dict], race_id: str | None) -> dict | None:
    if race_id:
        match = next((item for item in options if item.get("id") == race_id), None)
        if match:
            return match
    with_results = [item for item in options if item.get("logged_count")]
    if with_results:
        return with_results[0]
    return options[0] if options else None


def _results_data(ctx: AppContext, race_id: str | None, sort_by: str, completed_only: bool) -> dict:
    options = _race_options(ctx)
    race = _selected_race(options, race_id)
    runners = ctx.rows("runners")
    registrations = ctx.rows("registrations")
    rows = []
    if race:
        raw = [row for row in registrations if row.get("marathon_id") == race["id"]]
        enriched = [result_service.enrich_result(row, runners, [race]) for row in raw]
        if completed_only:
            enriched = [row for row in enriched if row.get("logged")]
        rows = result_service.sort_results(enriched, sort_by)
    my_result = None
    if ctx.runner and race:
        my_result = next((row for row in rows if row.get("runner_id") == ctx.runner.get("id")), None)
        if my_result is None:
            raw = next(
                (
                    row
                    for row in registrations
                    if row.get("marathon_id") == race["id"] and row.get("runner_id") == ctx.runner.get("id")
                ),
                None,
            )
            if raw:
                my_result = result_service.enrich_result(raw, runners, [race])
    certificates = []
    if ctx.runner and race:
        certificates = certificate_service.list_certificates(ctx.db, ctx.group_id, ctx.runner["id"], race["id"])
    return {
        "races": options,
        "race": race,
        "rows": rows,
        "summary": result_service.summarize(rows),
        "sort_by": sort_by,
        "completed_only": completed_only,
        "my_result": my_result,
        "can_upload": bool(my_result and my_result.get("logged")),
        "certificates": certificates,
        "statuses": STATUSES,
    }


@router.get("/results")
def results_page(
    request: Request,
    tab: str = "results",
    race_id: str | None = None,
    sort: str = "time",
    completed: int = 1,
    ctx: AppContext = Depends(require_group),
):
    tab = tab if tab in PROFILE_TABS else "results"
    data = _results_data(ctx, race_id, sort, bool(completed))
    context = page_context(
        request,
        ctx,
        "results",
        "Results & Times",
        "Finish times for registered runners",
        tab=tab,
        **data,
    )
    if wants_htmx(request):
        template = "partials/results/certificates.html" if tab == "certificates" else "partials/results/list.html"
        return templates.TemplateResponse(request, template, context)
    return templates.TemplateResponse(request, "pages/results.html", context)


@router.get("/results/partials/{tab}")
def results_partial(
    tab: str,
    request: Request,
    race_id: str | None = None,
    sort: str = "time",
    completed: int = 1,
    ctx: AppContext = Depends(require_group),
):
    tab = tab if tab in PROFILE_TABS else "results"
    data = _results_data(ctx, race_id, sort, bool(completed))
    template = "partials/results/certificates.html" if tab == "certificates" else "partials/results/list.html"
    return templates.TemplateResponse(
        request,
        template,
        page_context(request, ctx, "results", "Results & Times", "", tab=tab, **data),
    )


@router.post("/results/{registration_id}")
def log_result(
    registration_id: str,
    request: Request,
    status: str = Form("completed"),
    gun_time: str = Form(""),
    chip_time: str = Form(""),
    place_overall: str = Form(""),
    place_gender: str = Form(""),
    place_age_group: str = Form(""),
    race_distance: str = Form(""),
    result_notes: str = Form(""),
    bib: str = Form(""),
    race_id: str | None = Form(None),
    ctx: AppContext = Depends(require_group),
):
    if not ctx.can_write():
        return _result_error(request, ctx, race_id, "No permission to log results")
    try:
        result_service.save_result(
            ctx.db,
            registration_id,
            {
                "status": status,
                "gun_time": gun_time,
                "chip_time": chip_time,
                "place_overall": place_overall,
                "place_gender": place_gender,
                "place_age_group": place_age_group,
                "race_distance": race_distance,
                "result_notes": result_notes,
                "bib": bib,
            },
        )
        ctx.invalidate("registrations", "personal_records", "runner_badges", "runners", "community_posts")
    except ResultError as exc:
        return _result_error(request, ctx, race_id, str(exc))
    if wants_htmx(request):
        data = _results_data(ctx, race_id, "time", True)
        return templates.TemplateResponse(
            request,
            "partials/results/list.html",
            page_context(request, ctx, "results", "Results & Times", "", tab="results", form_ok="Result saved.", **data),
        )
    target = f"/results?tab=results&race_id={race_id}" if race_id else "/results?tab=results"
    return RedirectResponse(f"{target}&flash=Result+saved", status_code=303)


@router.post("/results/certificates")
async def upload_certificate(
    request: Request,
    race_id: str = Form(...),
    file: UploadFile = File(...),
    ctx: AppContext = Depends(require_group),
):
    if not ctx.runner:
        return _certificate_error(request, ctx, race_id, "No linked runner profile")
    content = await file.read()
    try:
        certificate_service.upload_for_result(
            ctx.db,
            group_id=ctx.group_id,
            runner_id=ctx.runner["id"],
            user_id=ctx.user_id,
            race_id=race_id,
            filename=file.filename or "certificate",
            content=content,
            content_type=file.content_type or "",
            registrations=ctx.rows("registrations"),
            races=ctx.rows("marathons"),
        )
        ctx.invalidate()
    except CertificateError as exc:
        return _certificate_error(request, ctx, race_id, str(exc))
    data = _results_data(ctx, race_id, "time", True)
    context = page_context(request, ctx, "results", "Results & Times", "", tab="certificates", form_ok="Certificate uploaded.", **data)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/results/certificates.html", context)
    return RedirectResponse(f"/results?tab=certificates&race_id={race_id}&flash=Certificate+uploaded", status_code=303)


def _result_error(request: Request, ctx: AppContext, race_id: str | None, message: str):
    data = _results_data(ctx, race_id, "time", True)
    context = page_context(request, ctx, "results", "Results & Times", "", tab="results", form_error=message, **data)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/results/list.html", context, status_code=400)
    return templates.TemplateResponse(request, "pages/results.html", context, status_code=400)


def _certificate_error(request: Request, ctx: AppContext, race_id: str, message: str):
    data = _results_data(ctx, race_id, "time", True)
    context = page_context(request, ctx, "results", "Results & Times", "", tab="certificates", form_error=message, **data)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/results/certificates.html", context, status_code=400)
    return templates.TemplateResponse(request, "pages/results.html", context, status_code=400)
