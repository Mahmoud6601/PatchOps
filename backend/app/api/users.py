from typing import List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, field_validator
from app.database import get_db
from app.models.models import AuditLog, ServerGroup, User, RoleEnum
from app.schemas.schemas import UserCreate, UserResponse, validate_enterprise_email
from app.services.auth_service import require_admin, get_password_hash
from app.services.rbac_service import normalize_group_scope, normalize_os_scope

router = APIRouter(prefix="/users", tags=["User Management"])


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[RoleEnum] = None
    is_active: Optional[bool] = None
    allowed_group_ids: Optional[List[int]] = None
    allowed_os_families: Optional[List[Literal["linux", "windows"]]] = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_blank_email(cls, value):
        return validate_enterprise_email(value)

    @field_validator("full_name", mode="before")
    @classmethod
    def normalize_full_name(cls, value):
        if isinstance(value, str):
            return value.strip() or None
        return value


class PasswordReset(BaseModel):
    new_password: str = Field(min_length=12, max_length=72)

    @field_validator("new_password")
    @classmethod
    def validate_password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value


@router.get("", response_model=List[UserResponse])
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return db.query(User).order_by(User.created_at.desc()).all()


def _validate_group_ids_exist(db: Session, group_ids: Optional[list[int]]) -> Optional[list[int]]:
    cleaned = normalize_group_scope(group_ids)
    if not cleaned:
        return None
    existing_count = db.query(ServerGroup.id).filter(ServerGroup.id.in_(cleaned)).count()
    if existing_count != len(cleaned):
        raise HTTPException(status_code=404, detail="One or more assigned customer groups were not found")
    return cleaned


@router.post("", response_model=UserResponse, status_code=201)
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    existing = db.query(User).filter(User.username == user_in.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    if user_in.email:
        existing_email = db.query(User).filter(func.lower(User.email) == user_in.email.lower()).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email already registered")

    is_admin_role = user_in.role == RoleEnum.ADMIN
    scoped_groups = None if is_admin_role else _validate_group_ids_exist(db, user_in.allowed_group_ids)
    scoped_os = None if is_admin_role else normalize_os_scope(user_in.allowed_os_families)

    new_user = User(
        username=user_in.username,
        email=user_in.email,
        password_hash=get_password_hash(user_in.password),
        full_name=user_in.full_name,
        role=user_in.role,
        allowed_group_ids=scoped_groups,
        allowed_os_families=scoped_os,
    )
    db.add(new_user)
    db.add(AuditLog(
        username=current_user.username,
        action="CREATE_USER",
        target_resource=user_in.username,
        details=(
            f"Created user '{user_in.username}' with role '{user_in.role.value}' "
            f"(groups={scoped_groups or 'ALL'}, os={scoped_os or 'ALL'})"
        ),
    ))
    db.commit()
    db.refresh(new_user)
    return new_user


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    user_in: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id and user_in.role is not None and user_in.role != RoleEnum.ADMIN:
        raise HTTPException(status_code=400, detail="Cannot demote your own administrator account")

    if "full_name" in user_in.model_fields_set:
        user.full_name = user_in.full_name

    if "email" in user_in.model_fields_set:
        if user_in.email:
            duplicate_email = db.query(User).filter(
                func.lower(User.email) == user_in.email.lower(),
                User.id != user.id,
            ).first()
            if duplicate_email:
                raise HTTPException(status_code=400, detail="Email already registered")
        user.email = user_in.email

    if user_in.role is not None:
        user.role = user_in.role

    if "allowed_group_ids" in user_in.model_fields_set:
        user.allowed_group_ids = _validate_group_ids_exist(db, user_in.allowed_group_ids)

    if "allowed_os_families" in user_in.model_fields_set:
        user.allowed_os_families = normalize_os_scope(user_in.allowed_os_families)

    if user.role == RoleEnum.ADMIN:
        user.allowed_group_ids = None
        user.allowed_os_families = None

    if user_in.is_active is not None:
        if user.id == current_user.id and not user_in.is_active:
            raise HTTPException(status_code=400, detail="Cannot deactivate your own account")
        if user.is_active and not user_in.is_active:
            user.token_version = (user.token_version or 0) + 1
        user.is_active = user_in.is_active

    db.add(AuditLog(
        username=current_user.username,
        action="UPDATE_USER",
        target_resource=user.username,
        details=(
            f"Updated user '{user.username}': role={user.role.value}, active={user.is_active}, "
            f"groups={user.allowed_group_ids or 'ALL'}, os={user.allowed_os_families or 'ALL'}"
        ),
    ))
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/reset-password", status_code=204)
def reset_user_password(
    user_id: int,
    body: PasswordReset,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.password_hash = get_password_hash(body.new_password)
    user.token_version = (user.token_version or 0) + 1
    db.add(AuditLog(
        username=current_user.username,
        action="RESET_PASSWORD",
        target_resource=user.username,
        details=f"Password reset for user '{user.username}' by administrator",
    ))
    db.commit()


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    username = user.username
    db.delete(user)
    db.add(AuditLog(
        username=current_user.username,
        action="DELETE_USER",
        target_resource=username,
        details=f"Deleted user account '{username}'",
    ))
    db.commit()
