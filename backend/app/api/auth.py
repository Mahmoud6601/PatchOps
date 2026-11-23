from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from jose import JWTError, jwt
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.models.models import AuditLog, User
from app.schemas.schemas import (
    SelfPasswordChange,
    SelfProfileUpdate,
    Token,
    UserLogin,
    UserResponse,
)
from app.services.auth_service import (
    REFRESH_COOKIE_NAME,
    create_access_token,
    create_refresh_token,
    decode_and_verify_token,
    get_current_user,
    get_password_hash,
    oauth2_scheme,
    revoke_token_payload,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _extract_client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    forwarded_real = request.headers.get("x-real-ip")
    if forwarded_real:
        return forwarded_real.strip()[:50]
    if request.client and request.client.host:
        return str(request.client.host)[:50]
    return None


def _is_secure_request(request: Optional[Request]) -> bool:
    if request is None:
        return False
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return str(proto).lower() == "https"


def _set_refresh_cookie(response: Response, refresh_token: str, request: Optional[Request]) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        secure=_is_secure_request(request),
        samesite="lax",
        path=f"{settings.API_V1_STR}/auth",
        max_age=settings.REFRESH_TOKEN_EXPIRE_HOURS * 3600,
    )


def _enforce_login_rate_limit(db: Session, username: str, client_ip: Optional[str]) -> None:
    window_start = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
    conditions = [AuditLog.username == username]
    if client_ip:
        conditions.append(AuditLog.ip_address == client_ip)

    recent_failures = (
        db.query(AuditLog.id)
        .filter(
            AuditLog.action == "LOGIN_FAILED",
            AuditLog.timestamp >= window_start,
            or_(*conditions),
        )
        .count()
    )
    if recent_failures >= settings.LOGIN_MAX_ATTEMPTS:
        already_logged_lockout = (
            db.query(AuditLog.id)
            .filter(
                AuditLog.action == "LOGIN_LOCKED",
                AuditLog.timestamp >= window_start,
                AuditLog.username == username[:50],
            )
            .first()
        )
        if not already_logged_lockout:
            db.add(AuditLog(
                username=username[:50] or "unknown",
                action="LOGIN_LOCKED",
                target_resource="auth/login",
                details=f"Account/IP temporarily locked after {recent_failures} failed login attempts",
                ip_address=client_ip,
            ))
            db.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed login attempts. Try again in {settings.LOGIN_LOCKOUT_MINUTES} minutes.",
        )


@router.post("/login", response_model=Token)
def login(
    login_data: UserLogin,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    client_ip = _extract_client_ip(request)
    normalized_username = (login_data.username or "").strip()
    _enforce_login_rate_limit(db, normalized_username, client_ip)

    user = db.query(User).filter(User.username == normalized_username).first()
    if not user or not verify_password(login_data.password, user.password_hash):
        db.add(AuditLog(
            username=normalized_username[:50] or "unknown",
            action="LOGIN_FAILED",
            target_resource="auth/login",
            details="Invalid username or password",
            ip_address=client_ip,
        ))
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    if not user.is_active:
        db.add(AuditLog(
            username=user.username,
            action="LOGIN_FAILED",
            target_resource="auth/login",
            details="Attempted login to deactivated account",
            ip_address=client_ip,
        ))
        db.commit()
        raise HTTPException(status_code=400, detail="Inactive user")

    access_token = create_access_token(
        data={"sub": user.username, "role": user.role.value, "tv": user.token_version or 0}
    )
    refresh_token = create_refresh_token(user)
    _set_refresh_cookie(response, refresh_token, request)

    db.add(AuditLog(
        username=user.username,
        action="LOGIN",
        target_resource="auth/session",
        details="Successful authentication",
        ip_address=client_ip,
    ))
    db.commit()

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "role": user.role.value,
        "username": user.username,
    }


@router.post("/refresh", response_model=Token)
def refresh_access_token(
    request: Request,
    response: Response,
    patching_refresh_token: Optional[str] = Cookie(default=None),
    db: Session = Depends(get_db),
):
    if not patching_refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active refresh session")

    user, old_payload = decode_and_verify_token(patching_refresh_token, db, expected_type="refresh")
    revoke_token_payload(db, old_payload)

    new_access_token = create_access_token(
        data={"sub": user.username, "role": user.role.value, "tv": user.token_version or 0}
    )
    new_refresh_token = create_refresh_token(user)
    _set_refresh_cookie(response, new_refresh_token, request)
    db.commit()

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "role": user.role.value,
        "username": user.username,
    }


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    token: str = Depends(oauth2_scheme),
    patching_refresh_token: Optional[str] = Cookie(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    client_ip = _extract_client_ip(request)
    for raw_tok in (token, patching_refresh_token):
        if not raw_tok:
            continue
        try:
            payload = jwt.decode(raw_tok, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            revoke_token_payload(db, payload)
        except JWTError:
            pass

    response.delete_cookie(key=REFRESH_COOKIE_NAME, path=f"{settings.API_V1_STR}/auth")
    db.add(AuditLog(
        username=current_user.username,
        action="LOGOUT",
        target_resource="auth/session",
        details="User signed out and revoked session tokens",
        ip_address=client_ip,
    ))
    db.commit()
    return {"status": "logged_out"}


@router.get("/me", response_model=UserResponse)
def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.put("/me", response_model=UserResponse)
def update_own_profile(
    profile_in: SelfProfileUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    changes = profile_in.model_dump(exclude_unset=True)
    if "full_name" in changes:
        current_user.full_name = changes["full_name"]

    if "email" in changes:
        new_email = changes["email"]
        if new_email:
            duplicate = (
                db.query(User.id)
                .filter(func.lower(User.email) == new_email.lower(), User.id != current_user.id)
                .first()
            )
            if duplicate:
                raise HTTPException(status_code=400, detail="Email already registered")
        current_user.email = new_email

    db.add(AuditLog(
        username=current_user.username,
        action="UPDATE_PROFILE",
        target_resource=current_user.username,
        details="User updated own profile details",
        ip_address=_extract_client_ip(request),
    ))
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/change-password", response_model=Token)
def change_own_password(
    payload: SelfPasswordChange,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="New password must be different from current password")

    current_user.password_hash = get_password_hash(payload.new_password)
    current_user.token_version = (current_user.token_version or 0) + 1

    new_access_token = create_access_token(
        data={"sub": current_user.username, "role": current_user.role.value, "tv": current_user.token_version}
    )
    new_refresh_token = create_refresh_token(current_user)
    _set_refresh_cookie(response, new_refresh_token, request)

    db.add(AuditLog(
        username=current_user.username,
        action="CHANGE_PASSWORD",
        target_resource=current_user.username,
        details="User changed own password and rotated session token version",
        ip_address=_extract_client_ip(request),
    ))
    db.commit()

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "role": current_user.role.value,
        "username": current_user.username,
    }
