from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import (
    get_current_session,
    get_current_user,
    require_admin_csrf,
    require_csrf,
)
from app.accounts.models import User, UserSession
from app.accounts.schemas import (
    LoginRequest,
    LoginResponse,
    SelfUpdate,
    UserCreate,
    UserResponse,
    UserUpdate,
)
from app.accounts.service import (
    authenticate,
    clear_login_failures,
    create_session,
    create_user,
    ensure_login_allowed,
    get_user_or_raise,
    password_hasher,
    record_login_failure,
    revoke_session,
    set_user_email,
    verify_password,
)
from app.api.errors import DomainError
from app.audit.service import record_audit
from app.core.config import get_settings
from app.db.session import get_db
from app.notifications.service import queue_account_created_email

router = APIRouter()
auth_router = APIRouter(prefix="/auth", tags=["authentication"])
users_router = APIRouter(prefix="/users", tags=["users"])


@auth_router.post("/login", response_model=LoginResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> LoginResponse:
    client_address = request.client.host if request.client else "unknown"
    ensure_login_allowed(db, payload.username, client_address)
    user = authenticate(db, payload.username, payload.password)
    if user is None:
        record_login_failure(db, payload.username, client_address)
        db.commit()
        error = DomainError("Invalid username or password")
        error.status_code = 401
        error.code = "invalid_credentials"
        raise error
    clear_login_failures(db, payload.username, client_address)
    created = create_session(db, user)
    db.commit()
    settings = get_settings()
    response.set_cookie(
        key=settings.session_cookie_name,
        value=created.raw_token,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
        path="/",
    )
    return LoginResponse(
        user=UserResponse.model_validate(user), csrf_token=created.session.csrf_token
    )


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    revoke_session(session)
    db.commit()
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@auth_router.get("/me", response_model=UserResponse)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@auth_router.patch("/me", response_model=UserResponse)
def update_me(
    payload: SelfUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> User:
    user = session.user
    changed_fields: list[str] = []
    if payload.display_name is not None:
        user.display_name = payload.display_name.strip()
        changed_fields.append("display_name")
    if payload.email is not None:
        set_user_email(db, user, payload.email)
        changed_fields.append("email")
    if payload.new_password is not None:
        if not payload.current_password:
            raise DomainError("Current password is required to set a new password")
        if not verify_password(user, payload.current_password):
            raise DomainError("Current password is incorrect")
        user.password_hash = password_hasher.hash(payload.new_password)
        user.must_change_password = False
        changed_fields.append("password")
        for other_session in user.sessions:
            if other_session.revoked_at is None and other_session.id != session.id:
                revoke_session(other_session)
    if changed_fields:
        record_audit(
            db,
            action="user.self_updated",
            entity_type="user",
            entity_id=user.id,
            actor_id=user.id,
            summary=f"{user.username} updated their account",
            metadata={"fields": changed_fields},
        )
    db.commit()
    return user


@auth_router.get("/session", response_model=LoginResponse)
def browser_session(
    session: UserSession = Depends(get_current_session),
) -> LoginResponse:
    return LoginResponse(
        user=UserResponse.model_validate(session.user), csrf_token=session.csrf_token
    )


@users_router.get("", response_model=list[UserResponse])
def list_users(
    caller: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[UserResponse]:
    users = db.scalars(select(User).order_by(User.username))
    return [
        UserResponse(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            email=user.email if caller.is_admin or caller.id == user.id else None,
            is_admin=user.is_admin if caller.is_admin else False,
            is_active=user.is_active,
            must_change_password=(
                user.must_change_password
                if caller.is_admin or caller.id == user.id
                else False
            ),
        )
        for user in users
    ]


@users_router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def add_user(
    payload: UserCreate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> User:
    user = create_user(
        db,
        payload.username,
        payload.display_name,
        payload.password,
        email=payload.email,
        must_change_password=True,
    )
    record_audit(
        db,
        action="user.created",
        entity_type="user",
        entity_id=user.id,
        actor_id=admin.id,
        summary=f"Created user {user.username}",
    )
    queue_account_created_email(db, user)
    db.commit()
    return user


@users_router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: str,
    payload: UserUpdate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> User:
    user = get_user_or_raise(db, user_id)
    changed_fields: list[str] = []
    if payload.display_name is not None:
        user.display_name = payload.display_name.strip()
        changed_fields.append("display_name")
    if payload.email is not None:
        set_user_email(db, user, payload.email)
        changed_fields.append("email")
    if payload.is_active is not None:
        if user.id == admin.id and not payload.is_active:
            raise DomainError(
                "The active administrator cannot disable their own account"
            )
        user.is_active = payload.is_active
        changed_fields.append("is_active")
        if not user.is_active:
            for session in user.sessions:
                if session.revoked_at is None:
                    revoke_session(session)
    if payload.password is not None:
        user.password_hash = password_hasher.hash(payload.password)
        user.must_change_password = True
        changed_fields.append("password")
        for session in user.sessions:
            if session.revoked_at is None:
                revoke_session(session)
    if changed_fields:
        record_audit(
            db,
            action="user.updated",
            entity_type="user",
            entity_id=user.id,
            actor_id=admin.id,
            summary=f"Updated user {user.username}",
            metadata={"fields": changed_fields, "isActive": user.is_active},
        )
    db.commit()
    return user


router.include_router(auth_router)
router.include_router(users_router)
