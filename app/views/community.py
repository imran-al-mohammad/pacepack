from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from app.db import SupabaseError
from app.deps import AppContext, require_group, wants_htmx
from app.services.community_service import is_system_post
from app.templating import page_context, templates

router = APIRouter(tags=["community"])


def _feed(ctx: AppContext, tab: str) -> dict:
    posts = ctx.rows("community_posts", order="created_at.desc")
    runners = {row.get("id"): row for row in ctx.rows("runners")}
    topics = []
    replies: dict[str, list] = {}
    for post in posts:
        post = {
            **post,
            "runner_name": (runners.get(post.get("runner_id")) or {}).get("name"),
            "system": is_system_post(post),
        }
        if post.get("parent_id"):
            replies.setdefault(post["parent_id"], []).append(post)
        else:
            topics.append(post)
    if tab == "announcements":
        topics = [post for post in topics if post.get("system") or post.get("post_type") == "announcement"]
    elif tab == "board":
        topics = [post for post in topics if not post.get("system") and post.get("post_type") != "announcement"]
    topics.sort(key=lambda post: (not post.get("is_pinned"), str(post.get("created_at") or "")), reverse=False)
    topics.sort(key=lambda post: str(post.get("created_at") or ""), reverse=True)
    return {"topics": topics, "replies": replies, "tab": tab}


@router.get("/community")
def community(request: Request, tab: str = "all", ctx: AppContext = Depends(require_group)):
    tab = tab if tab in {"all", "announcements", "board"} else "all"
    data = _feed(ctx, tab)
    context = page_context(request, ctx, "community", "Community", "Group board for topics, tips, and race-day chat", **data)
    if wants_htmx(request):
        return templates.TemplateResponse(request, "partials/community_feed.html", context)
    return templates.TemplateResponse(request, "pages/community.html", context)


@router.post("/community")
def create_post(
    request: Request,
    content: str = Form(...),
    title: str = Form(""),
    parent_id: str = Form(""),
    ctx: AppContext = Depends(require_group),
):
    if not ctx.can_write():
        return RedirectResponse("/community?error=No+permission", status_code=303)
    payload = {
        "group_id": ctx.group_id,
        "user_id": ctx.user_id,
        "runner_id": (ctx.runner or {}).get("id"),
        "title": title.strip() or None,
        "content": content.strip(),
        "post_type": "board",
        "parent_id": parent_id or None,
    }
    if not payload["content"]:
        return RedirectResponse("/community?error=Write+something+first", status_code=303)
    try:
        ctx.db.insert("community_posts", payload)
    except SupabaseError as exc:
        return RedirectResponse(f"/community?error={exc}", status_code=303)
    ctx.invalidate("community_posts")
    if wants_htmx(request):
        return templates.TemplateResponse(
            request,
            "partials/community_feed.html",
            page_context(request, ctx, "community", "Community", "", **_feed(ctx, "all"), form_ok="Posted."),
        )
    return RedirectResponse("/community?flash=Posted", status_code=303)
