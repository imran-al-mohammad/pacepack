from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import RedirectResponse

from app.deps import AppContext, require_group, wants_htmx
from app.services import certificate_service
from app.services.certificate_service import CertificateError
from app.templating import page_context, templates
from app.views.results import _results_data

router = APIRouter(tags=["certificates"])


def _page(request: Request, ctx: AppContext, race_id: str | None, **extra):
    data = _results_data(ctx, race_id, "time", True)
    return page_context(
        request,
        ctx,
        "certificates",
        "Certificates",
        "Upload and view certificates for logged results",
        **data,
        **extra,
    )


@router.get("/certificates")
def certificates_page(
    request: Request,
    race_id: str | None = None,
    ctx: AppContext = Depends(require_group),
):
    context = _page(request, ctx, race_id)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/certificates.html", context)
    return templates.TemplateResponse(request, "pages/certificates.html", context)


@router.get("/certificates/partial")
def certificates_partial(
    request: Request,
    race_id: str | None = None,
    ctx: AppContext = Depends(require_group),
):
    return templates.TemplateResponse(
        request,
        "partials/certificates.html",
        _page(request, ctx, race_id),
    )


@router.post("/certificates")
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
    context = _page(request, ctx, race_id, form_ok="Certificate uploaded.")
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/certificates.html", context)
    return RedirectResponse(f"/certificates?race_id={race_id}&flash=Certificate+uploaded", status_code=303)


def _certificate_error(request: Request, ctx: AppContext, race_id: str, message: str):
    context = _page(request, ctx, race_id, form_error=message)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/certificates.html", context, status_code=400)
    return templates.TemplateResponse(request, "pages/certificates.html", context, status_code=400)
