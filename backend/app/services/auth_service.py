import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.models.models import RevokedToken, User, RoleEnum

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/auth/login")
REFRESH_COOKIE_NAME = "patching_refresh_token"


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except Exception:
        return False


def get_password_hash(password: str) -> str:
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must be at most 72 UTF-8 bytes")
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta if expires_delta else timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.setdefault("jti", uuid.uuid4().hex)
    to_encode.setdefault("type", "access")
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(user: User, expires_delta: Optional[timedelta] = None) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta if expires_delta else timedelta(hours=settings.REFRESH_TOKEN_EXPIRE_HOURS)
    )
    payload = {
        "sub": user.username,
        "role": user.role.value,
        "tv": user.token_version or 0,
        "jti": uuid.uuid4().hex,
        "type": "refresh",
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def revoke_token_payload(db: Session, payload: dict) -> None:
    jti = payload.get("jti")
    username = payload.get("sub") or "unknown"
    exp_ts = payload.get("exp")
    if not jti:
        return
    # Prune expired blacklist entries opportunistically
    now = _utcnow_naive()
    db.query(RevokedToken).filter(RevokedToken.expires_at < now).delete(synchronize_session=False)
    if db.query(RevokedToken.id).filter(RevokedToken.jti == jti).first() is None:
        expires_at = (
            datetime.fromtimestamp(exp_ts, tz=timezone.utc).replace(tzinfo=None)
            if isinstance(exp_ts, (int, float))
            else now + timedelta(hours=settings.REFRESH_TOKEN_EXPIRE_HOURS)
        )
        db.add(RevokedToken(jti=jti, username=str(username)[:50], expires_at=expires_at))


def decode_and_verify_token(token: str, db: Session, expected_type: str = "access") -> tuple[User, dict]:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        username: Optional[str] = payload.get("sub")
        token_type: str = payload.get("type", "access")
        if username is None or token_type != expected_type:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    jti = payload.get("jti")
    if jti and db.query(RevokedToken.id).filter(RevokedToken.jti == jti).first() is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session token has been revoked",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception

    if "tv" in payload and int(payload["tv"]) != int(user.token_version or 0):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session invalidated by credential rotation",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user, payload


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    user, _ = decode_and_verify_token(token, db, expected_type="access")
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != RoleEnum.ADMIN:
        raise HTTPException(status_code=403, detail="Administrator permissions required")
    return current_user


def require_operator_or_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in [RoleEnum.ADMIN, RoleEnum.OPERATOR]:
        raise HTTPException(status_code=403, detail="Operator or Administrator permissions required")
    return current_user
