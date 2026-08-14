from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from app.db import SupabaseError
from app.deps import AppContext, require_role
from app.templating import page_context, templates

router = APIRouter(tags=["admin"])


@router.get("/admin")
def admin(request: Request, ctx: AppContext = Depends(require_role("moderator"))):
    members = ctx.db.select("group_memberships", filters={"group_id": f"eq.{ctx.group_id}"})
    profiles = {row.get("id"): row for row in ctx.db.select("profiles", filters={"group_id": f"eq.{ctx.group_id}"})}
    # Fallback: fetch missing profiles individually if the group_id filter is empty
    team = []
    for member in members:
        profile = profiles.get(member.get("user_id"))
        if not profile:
            profile = ctx.db.select_one("profiles", id=f"eq.{member.get('user_id')}") or {
                "display_name": "User",
                "email": "",
            }
        team.append({**member, "profile": profile})
    team.sort(key=lambda item: ({"admin": 0, "moderator": 1, "member": 2}.get(item.get("role"), 9), (item["profile"].get("display_name") or "")))
    return templates.TemplateResponse(
        request,
        "pages/admin.html",
        page_context(
            request,
            ctx,
            "admin",
            "Admin",
            "Users, logo, roles, and permissions",
            team=team,
        ),
    )


@router.post("/admin/role")
def set_role(
    user_id: str = Form(...),
    role: str = Form(...),
    ctx: AppContext = Depends(require_role("admin")),
):
    try:
        ctx.db.rpc("set_member_role", {"p_group_id": ctx.group_id, "p_user_id": user_id, "p_role": role})
    except SupabaseError as exc:
        return RedirectResponse(f"/admin?error={exc}", status_code=303)
    return RedirectResponse("/admin?flash=Role+updated", status_code=303)


@router.post("/admin/logo")
def save_logo(logo_url: str = Form(""), ctx: AppContext = Depends(require_role("admin"))):
    try:
        ctx.db.update("groups", {"id": f"eq.{ctx.group_id}"}, {"logo_url": logo_url.strip()})
    except SupabaseError as exc:
        return RedirectResponse(f"/admin?error={exc}", status_code=303)
    return RedirectResponse("/admin?flash=Logo+saved", status_code=303)
