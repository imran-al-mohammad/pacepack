from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse

from app.db import SupabaseError
from app.deps import AppContext, require_group, wants_htmx
from app.services import analytics_service, badge_service, certificate_service, pr_service
from app.services.analytics_service import format_distance
from app.services.certificate_service import CertificateError
from app.services.result_service import enrich_result
from app.services.time_utils import format_date
from app.templating import page_context, templates

router = APIRouter(tags=["profile"])
TABS = ("overview", "analytics", "records", "badges", "history", "certificates", "settings")
TAB_TEMPLATES = {tab: f"partials/profile/{tab}.html" for tab in TABS}


def _profile_payload(ctx: AppContext) -> dict:
    runner = ctx.runner
    runner_id = runner.get("id") if runner else None
    races = ctx.rows("marathons", order="race_date.desc")
    registrations = ctx.rows("registrations")
    records = ctx.rows("personal_records")
    badge_rows = ctx.rows("runner_badges")
    stats = analytics_service.runner_stats(runner_id, races, registrations)
    analytics = analytics_service.profile_analytics(stats)
    mine = [row for row in registrations if runner_id and row.get("runner_id") == runner_id]
    history = [enrich_result(row, [runner] if runner else [], races) for row in mine]
    history.sort(key=lambda row: str((row.get("race") or {}).get("race_date") or ""), reverse=True)
    prs = pr_service.records_for_runner(records, runner_id)
    stored_badges = [row for row in badge_rows if row.get("runner_id") == runner_id]
    eligible = badge_service.eligible_badges(runner_id, races, registrations, records) if runner_id else set()
    earned_keys = {row.get("badge_key") for row in stored_badges}
    # Show stored badges first; fill any eligible-but-not-yet-written ones so the
    # tab is never empty when historical results already qualify.
    merged = list(stored_badges)
    for key in eligible - earned_keys:
        merged.append({"badge_key": key, "runner_id": runner_id, "awarded_at": None, "auto": True})
    certificates = certificate_service.list_certificates(ctx.db, ctx.group_id, runner_id) if runner_id else []
    join_date = runner.get("join_date") if runner else None
    return {
        "runner": runner,
        "stats": stats,
        "analytics": analytics,
        "history": history,
        "prs": prs,
        "badges": badge_service.decorate_badges(merged),
        "certificates": certificates,
        "join_date_label": format_date(join_date) if join_date else "—",
        "format_distance": format_distance,
        "pace_groups": ["", "A", "B", "C", "D"],
    }


@router.get("/profile")
def profile_page(request: Request, tab: str = "overview", ctx: AppContext = Depends(require_group)):
    tab = tab if tab in TABS else "overview"
    data = _profile_payload(ctx)
    context = page_context(request, ctx, "profile", "My Profile", "Records, badges, and race history from logged results", tab=tab, **data)
    if wants_htmx(request):
        return templates.TemplateResponse(request, TAB_TEMPLATES[tab], context)
    return templates.TemplateResponse(request, "pages/profile.html", context)


@router.get("/profile/tabs/{tab}")
def profile_tab(tab: str, request: Request, ctx: AppContext = Depends(require_group)):
    tab = tab if tab in TABS else "overview"
    data = _profile_payload(ctx)
    return templates.TemplateResponse(
        request,
        TAB_TEMPLATES[tab],
        page_context(request, ctx, "profile", "My Profile", "", tab=tab, **data),
    )


@router.post("/profile/settings")
def save_settings(
    request: Request,
    display_name: str = Form(""),
    pace_group: str = Form(""),
    public_profile: str = Form(""),
    password: str = Form(""),
    password_confirm: str = Form(""),
    ctx: AppContext = Depends(require_group),
):
    error = None
    try:
        ctx.db.update("profiles", {"id": f"eq.{ctx.user_id}"}, {"display_name": display_name.strip()})
        if ctx.runner:
            ctx.db.update(
                "runners",
                {"id": f"eq.{ctx.runner['id']}"},
                {
                    "pace_group": pace_group.strip(),
                    "public_profile_enabled": public_profile == "on",
                    "name": display_name.strip() or ctx.runner.get("name"),
                },
            )
        if password:
            if password != password_confirm:
                raise ValueError("Passwords do not match")
            if len(password) < 8:
                raise ValueError("Password must be at least 8 characters")
            ctx.db.update_user({"password": password})
        ctx.invalidate("runners")
        ctx.profile["display_name"] = display_name.strip() or ctx.profile.get("display_name")
    except (SupabaseError, ValueError) as exc:
        error = str(exc)
    data = _profile_payload(ctx)
    context = page_context(
        request,
        ctx,
        "profile",
        "My Profile",
        "",
        tab="settings",
        form_error=error,
        form_ok=None if error else "Settings saved.",
        **data,
    )
    if wants_htmx(request):
        return templates.TemplateResponse(request, TAB_TEMPLATES["settings"], context, status_code=400 if error else 200)
    if error:
        return templates.TemplateResponse(request, "pages/profile.html", context, status_code=400)
    return RedirectResponse("/profile?tab=settings&flash=Settings+saved", status_code=303)


@router.post("/profile/certificates")
async def upload_profile_certificate(
    request: Request,
    race_id: str = Form(...),
    file: UploadFile = File(...),
    ctx: AppContext = Depends(require_group),
):
    if not ctx.runner:
        error = "No linked runner profile"
        data = _profile_payload(ctx)
        context = page_context(request, ctx, "profile", "My Profile", "", tab="certificates", form_error=error, **data)
        template = TAB_TEMPLATES["certificates"] if wants_htmx(request) else "pages/profile.html"
        return templates.TemplateResponse(request, template, context, status_code=400)
    try:
        certificate_service.upload_for_result(
            ctx.db,
            group_id=ctx.group_id,
            runner_id=ctx.runner["id"],
            user_id=ctx.user_id,
            race_id=race_id,
            filename=file.filename or "certificate",
            content=await file.read(),
            content_type=file.content_type or "",
            registrations=ctx.rows("registrations"),
            races=ctx.rows("marathons"),
        )
        ctx.invalidate()
        error = None
    except CertificateError as exc:
        error = str(exc)
    data = _profile_payload(ctx)
    context = page_context(
        request,
        ctx,
        "profile",
        "My Profile",
        "",
        tab="certificates",
        form_error=error,
        form_ok=None if error else "Certificate uploaded.",
        **data,
    )
    if wants_htmx(request):
        return templates.TemplateResponse(request, TAB_TEMPLATES["certificates"], context, status_code=400 if error else 200)
    if error:
        return templates.TemplateResponse(request, "pages/profile.html", context, status_code=400)
    return RedirectResponse("/profile?tab=certificates&flash=Certificate+uploaded", status_code=303)
