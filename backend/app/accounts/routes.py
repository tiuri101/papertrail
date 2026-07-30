from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import (
    get_current_session,
    get_current_user,
    require_admin,
    require_admin_csrf,
    require_csrf,
)
from app.accounts.models import User, UserSession
from app.accounts.schemas import (
    LoginRequest,
    LoginResponse,
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
)
from app.api.errors import DomainError
from app.core.config import get_settings
from app.db.session import get_db

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
    return LoginResponse(user=user, csrf_token=created.session.csrf_token)


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


@auth_router.get("/session", response_model=LoginResponse)
def browser_session(
    session: UserSession = Depends(get_current_session),
) -> LoginResponse:
    return LoginResponse(user=session.user, csrf_token=session.csrf_token)


@users_router.get("", response_model=list[UserResponse])
def list_users(
    _: User = Depends(require_admin), db: Session = Depends(get_db)
) -> list[User]:
    return list(db.scalars(select(User).order_by(User.username)))


@users_router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def add_user(
    payload: UserCreate,
    _: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> User:
    user = create_user(db, payload.username, payload.display_name, payload.password)
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
    if payload.display_name is not None:
        user.display_name = payload.display_name.strip()
    if payload.is_active is not None:
        if user.id == admin.id and not payload.is_active:
            raise DomainError(
                "The active administrator cannot disable their own account"
            )
        user.is_active = payload.is_active
        if not user.is_active:
            for session in user.sessions:
                if session.revoked_at is None:
                    revoke_session(session)
    if payload.password is not None:
        user.password_hash = password_hasher.hash(payload.password)
        for session in user.sessions:
            if session.revoked_at is None:
                revoke_session(session)
    db.commit()
    return user


router.include_router(auth_router)
router.include_router(users_router)
