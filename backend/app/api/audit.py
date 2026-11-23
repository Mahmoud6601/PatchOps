from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.models import AuditLog, User
from app.schemas.schemas import AuditLogResponse
from app.services.auth_service import require_admin

router = APIRouter(prefix="/audit", tags=["Audit Logs"])

@router.get("", response_model=List[AuditLogResponse])
def get_audit_logs(
    search: Optional[str] = Query(None, max_length=100),
    action: Optional[str] = Query(None, max_length=50),
    username: Optional[str] = Query(None, max_length=50),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    query = db.query(AuditLog)
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(or_(
            AuditLog.username.ilike(term),
            AuditLog.action.ilike(term),
            AuditLog.target_resource.ilike(term),
            AuditLog.details.ilike(term),
        ))
    if action and action.strip():
        query = query.filter(AuditLog.action == action.strip().upper())
    if username and username.strip():
        query = query.filter(AuditLog.username == username.strip())
    return query.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit).all()
