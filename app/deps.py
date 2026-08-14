from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from app.config import Settings, get_settings
from app.db import SupabaseClient, SupabaseError, user_client

ROLE_RANK = {"member": 1, "moderator": 2, "admin": 3}


@dataclass
class AuthSession:
    user: dict[str, Any]
    access_token: str
    refresh_token: str | None = None
    refreshed: dict[str, str] | None = None


@dataclass
class AppContext:
    session: AuthSession
    profile: dict[str, Any]
    group: dict[str, Any] | None
    role: str | None
    runner: dict[str, Any] | None
    db: SupabaseClient
    settings: Settings
    unread: int = 0
    team_count: int = 0
    cache: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    @property
    def user(self) -> dict[str, Any]:
        return self.session.user

    @property
    def user_id(self) -> str:
        return self.session.user["id"]

    @property
    def group_id(self) -> str | None:
        if self.group:
            return self.group.get("id")
        return self.profile.get("group_id")

    def has_min_role(self, minimum: str) -> bool:
        return (ROLE_RANK.get(self.role) or 0) >= (ROLE_RANK.get(minimum) or 99)

    def can_write(self) -> bool:
        return self.has_min_role("member")

    def can_edit(self) -> bool:
        return self.has_min_role("moderator")

    def can_admin(self) -> bool:
        return self.has_min_role("admin")

    def rows(self, table: str, **kwargs: Any) -> list[dict[str, Any]]:
        if table in self.cache:
            return self.cache[table]
        if not self.group_id:
            self.cache[table] = []
            return []
        filters = {"group_id": f"eq.{self.group_id}"}
        extra = kwargs.pop("filters", None)
        if extra:
            filters.update(extra)
        self.cache[table] = self.db.select(table, filters=filters, **kwargs)
        return self.cache[table]

    def invalidate(self, *tables: str) -> None:
        for table in tables or list(self.cache):
            self.cache.pop(table, None)


def _read_tokens(request: Request, settings: Settings) -> tuple[str | None, str | None]:
    return (
        request.cookies.get(settings.access_cookie),
        request.cookies.get(settings.refresh_cookie),
    )


def load_session(request: Request, settings: Settings = Depends(get_settings)) -> AuthSession | None:
    access, refresh = _read_tokens(request, settings)
    if not access and not refresh:
        return None
    if access:
        try:
            user = user_client(access).get_user()
            return AuthSession(user=user, access_token=access, refresh_token=refresh)
        except SupabaseError:
            pass
    if refresh:
        try:
            tokens = user_client().refresh(refresh)
            new_access = tokens.get("access_token")
            new_refresh = tokens.get("refresh_token") or refresh
            if not new_access:
                return None
            user = user_client(new_access).get_user()
            return AuthSession(
                user=user,
                access_token=new_access,
                refresh_token=new_refresh,
                refreshed={"access": new_access, "refresh": new_refresh},
            )
        except SupabaseError:
            return None
    return None


def require_session(session: AuthSession | None = Depends(load_session)) -> AuthSession:
    if not session:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})
    return session


def get_context(
    request: Request,
    session: AuthSession = Depends(require_session),
    settings: Settings = Depends(get_settings),
) -> AppContext:
    db = user_client(session.access_token)
    profile = db.select_one("profiles", id=f"eq.{session.user['id']}") or {
        "id": session.user["id"],
        "display_name": session.user.get("user_metadata", {}).get("display_name") or session.user.get("email", "").split("@")[0],
        "email": session.user.get("email"),
        "group_id": None,
        "user_type": "member",
        "profile_picture_url": "",
    }
    membership = None
    group = None
    role = None
    if profile.get("group_id"):
        membership = db.select_one(
            "group_memberships",
            group_id=f"eq.{profile['group_id']}",
            user_id=f"eq.{session.user['id']}",
        )
        if membership:
            role = membership.get("role")
            group = db.select_one("groups", id=f"eq.{profile['group_id']}")
    if not membership:
        memberships = db.select("group_memberships", filters={"user_id": f"eq.{session.user['id']}"}, limit=1)
        if memberships:
            membership = memberships[0]
            role = membership.get("role")
            group = db.select_one("groups", id=f"eq.{membership['group_id']}")
            if group and not profile.get("group_id"):
                profile["group_id"] = group["id"]
    runner = None
    if group:
        runner = _resolve_runner(db, group["id"], session.user, profile)
    unread = 0
    team_count = 0
    if group:
        try:
            unread = len(
                db.select(
                    "notifications",
                    filters={
                        "user_id": f"eq.{session.user['id']}",
                        "group_id": f"eq.{group['id']}",
                        "is_read": "eq.false",
                    },
                    columns="id",
                    limit=50,
                )
            )
        except SupabaseError:
            unread = 0
        try:
            team_count = len(db.select("group_memberships", filters={"group_id": f"eq.{group['id']}"}, columns="id"))
        except SupabaseError:
            team_count = 0
    ctx = AppContext(
        session=session,
        profile=profile,
        group=group,
        role=role,
        runner=runner,
        db=db,
        settings=settings,
        unread=unread,
        team_count=team_count,
    )
    request.state.ctx = ctx
    return ctx


def require_group(ctx: AppContext = Depends(get_context)) -> AppContext:
    if not ctx.group:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/onboarding"})
    return ctx


def require_role(minimum: str):
    def _inner(ctx: AppContext = Depends(require_group)) -> AppContext:
        if not ctx.has_min_role(minimum):
            raise HTTPException(status_code=403, detail="You do not have permission for this action")
        return ctx

    return _inner


def _resolve_runner(db: SupabaseClient, group_id: str, user: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any] | None:
    linked = db.select_one("runners", group_id=f"eq.{group_id}", user_id=f"eq.{user['id']}")
    if linked:
        return linked
    email = (profile.get("email") or user.get("email") or "").strip().lower()
    name = (profile.get("display_name") or "").strip().lower()
    runners = db.select("runners", filters={"group_id": f"eq.{group_id}"})
    if email:
        matches = [r for r in runners if str(r.get("email") or "").strip().lower() == email]
        if len(matches) == 1:
            return matches[0]
    if name:
        matches = [r for r in runners if str(r.get("name") or "").strip().lower() == name]
        if len(matches) == 1:
            return matches[0]
    return None


def wants_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def redirect_login() -> RedirectResponse:
    return RedirectResponse("/login", status_code=303)
