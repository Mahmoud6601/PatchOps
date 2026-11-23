"""
Health endpoints: liveness, readiness, AWX connectivity check, and public Root CA download.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.config import settings
from app.models.models import User
from app.services.auth_service import get_current_user
from app.services.awx_client import awx_client, AWXClientError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/awx", summary="Check AWX Engine connectivity")
def check_awx_health(current_user: User = Depends(get_current_user)):
    """
    Performs a lightweight AWX API ping (lists machine credentials).
    Returns {"status": "online"} or {"status": "offline", "reason": "..."}.
    """
    try:
        awx_client.list_machine_credentials()
        return {"status": "online"}
    except AWXClientError as exc:
        logger.warning("AWX health check failed: %s", exc)
        return {"status": "offline", "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.error("AWX health check unexpected error: %s", exc)
        return {"status": "offline", "reason": "Unexpected error during AWX connectivity check"}


@router.get("/ca.crt", summary="Download PatchOps Internal Root CA certificate (public PEM)")
def download_platform_root_ca():
    """Serve the public Root CA certificate so administrators/GPO can trust PatchOps HTTPS & WinRM."""
    ca_path = Path(settings.PLATFORM_CA_CERT_PATH)
    if not ca_path.is_file():
        raise HTTPException(status_code=404, detail="Platform Root CA certificate is not provisioned")
    pem_bytes = ca_path.read_bytes()
    return Response(
        content=pem_bytes,
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="patchops-root-ca.crt"'},
    )
