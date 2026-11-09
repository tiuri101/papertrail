from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import (
    get_current_session,
    require_admin,
    require_admin_csrf,
    verify_csrf,
)
from app.accounts.models import User, UserSession
from app.accounts.schemas import (
    ForgotPasswordRequest,
    LoginRequest,
    LoginResponse,
    ResetPasswordRequest,
    SelfUpdate,
    UserCreate,
    UserResponse,
    UserUpdate,
)
from app.accounts.service import (
    authenticate,
    clear_login_failures,
    consume_password_reset_token,
    create_password_reset_token,
    create_session,
    create_user,
    ensure_login_allowed,
    ensure_password_reset_allowed,
    find_valid_password_reset_token,
    get_user_or_raise,
    normalize_email_address,
    record_login_failure,
    record_password_reset_attempt,
    revoke_session,
    set_user_email,
    set_user_password,
    verify_password,
)
from app.api.errors import DomainError
from app.audit.service import record_audit
from app.core.config import get_settings
from app.db.session import get_db
from app.notifications.encryption import encryption_available
from app.notifications.service import (
    queue_account_created_email,
    queue_password_reset_email,
)
from app.pdf_acquisition.service import revoke_all_agents_for_user

logger = logging.getLogger(__name__)

router = APIRouter()
auth_router = APIRouter(prefix="/auth", tags=["authentication"])
users_router = APIRouter(prefix="/users", tags=["users"])


def _set_session_cookie(response: Response, raw_token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=settings.session_cookie_name,
        value=raw_token,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
        path="/",
    )


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
    _set_session_cookie(response, created.raw_token)
    return LoginResponse(
        user=UserResponse.model_validate(user), csrf_token=created.session.csrf_token
    )


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    # Recovery endpoint: reachable while a mandatory password change is still
    # pending, so it verifies CSRF without requiring full authentication.
    session: UserSession = Depends(verify_csrf),
    db: Session = Depends(get_db),
) -> None:
    revoke_session(session)
    db.commit()
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@auth_router.post("/forgot-password", status_code=status.HTTP_204_NO_CONTENT)
def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> None:
    client_address = request.client.host if request.client else "unknown"
    normalized_email = normalize_email_address(payload.email)
    if normalized_email is not None:
        ensure_password_reset_allowed(db, normalized_email, client_address)
        record_password_reset_attempt(db, normalized_email, client_address)
        if get_settings().email_enabled:
            # Checked before the account lookup, so a misconfigured instance
            # behaves identically for known and unknown addresses -- this
            # response must never become an account-existence oracle.
            if not encryption_available():
                logger.error(
                    "Password reset emails are disabled: "
                    "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY is not configured, "
                    "so a reset link cannot be queued without persisting it in "
                    "clear text"
                )
            else:
                user = db.scalar(
                    select(User).where(
                        User.email == normalized_email, User.is_active.is_(True)
                    )
                )
                if user is not None:
                    created = create_password_reset_token(db, user)
                    queue_password_reset_email(
                        db, user, created.raw_token, reset_token_id=created.token.id
                    )
    db.commit()
    return None


@auth_router.post("/reset-password", response_model=LoginResponse)
def reset_password(
    payload: ResetPasswordRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> LoginResponse:
    token = find_valid_password_reset_token(db, payload.token)
    if token is None:
        error = DomainError("This password reset link is invalid or has expired")
        error.status_code = 400
        error.code = "invalid_reset_token"
        raise error
    user = token.user
    set_user_password(user, payload.new_password)
    user.must_change_password = False
    consume_password_reset_token(db, token)
    for other_session in user.sessions:
        if other_session.revoked_at is None:
            revoke_session(other_session)
    # A password reset means the account may have been compromised; a paired
    # browser helper authenticates independently of the password, so it must
    # not be left usable.
    revoke_all_agents_for_user(db, user, actor_id=user.id)
    record_audit(
        db,
        action="user.password_reset",
        entity_type="user",
        entity_id=user.id,
        actor_id=user.id,
        summary=f"{user.username} reset their password via emailed link",
    )
    created = create_session(db, user)
    db.commit()
    _set_session_cookie(response, created.raw_token)
    return LoginResponse(
        user=UserResponse.model_validate(user), csrf_token=created.session.csrf_token
    )


@auth_router.get("/me", response_model=UserResponse)
def me(session: UserSession = Depends(get_current_session)) -> User:
    # Recovery endpoint: a session owing a password change must still be able
    # to read back who it is.
    return session.user


@auth_router.patch("/me", response_model=UserResponse)
def update_me(
    payload: SelfUpdate,
    request: Request,
    # Recovery endpoint: this is where a mandatory password change is made,
    # so it must stay reachable while `must_change_password` is still set.
    session: UserSession = Depends(verify_csrf),
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
    if payload.ui_preferences is not None:
        # Cosmetic reviewer preferences (hotkeys, fonts, ...), not a security-
        # or identity-relevant change, so it's saved without an audit entry --
        # otherwise every hotkey tweak or font pick would spam the audit log.
        user.ui_preferences = payload.ui_preferences
    if payload.email_preferences is not None:
        user.email_preferences = {
            **(user.email_preferences or {}),
            **payload.email_preferences,
        }
        changed_fields.append("email_preferences")
    if payload.new_password is not None:
        client_address = request.client.host if request.client else "unknown"
        throttle_identity = f"currentpw:{user.id}"
        ensure_login_allowed(db, throttle_identity, client_address)
        if not payload.current_password:
            raise DomainError("Current password is required to set a new password")
        if not verify_password(user, payload.current_password):
            record_login_failure(db, throttle_identity, client_address)
            db.commit()
            raise DomainError("Current password is incorrect")
        clear_login_failures(db, throttle_identity, client_address)
        if payload.new_password == payload.current_password:
            raise DomainError(
                "New password must be different from your current password"
            )
        set_user_password(user, payload.new_password)
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
    _: User = Depends(require_admin), db: Session = Depends(get_db)
) -> list[UserResponse]:
    """The installation-wide user directory -- administrators only.

    Every authenticated account used to be able to read this, which handed any
    reviewer a roster of every username, display name and account state on the
    instance. Project owners who need candidates to add as members use the
    project-scoped `/projects/{project_id}/member-candidates` endpoint, which
    exposes only the identity fields the membership UI actually needs.
    """
    users = db.scalars(select(User).order_by(User.username))
    return [
        UserResponse(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            is_admin=user.is_admin,
            is_active=user.is_active,
            must_change_password=user.must_change_password,
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
            revoke_all_agents_for_user(db, user, actor_id=admin.id)
    if payload.password is not None:
        set_user_password(user, payload.password)
        user.must_change_password = True
        changed_fields.append("password")
        for session in user.sessions:
            if session.revoked_at is None:
                revoke_session(session)
        revoke_all_agents_for_user(db, user, actor_id=admin.id)
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
