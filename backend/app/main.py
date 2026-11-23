import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api import audit, auth, health as health_router, jobs, reports, schedules, servers, stream, users
from app.config import settings
from app.database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("patching_platform")

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json" if settings.ENABLE_API_DOCS else None,
    docs_url=f"{settings.API_V1_STR}/docs" if settings.ENABLE_API_DOCS else None,
    redoc_url=None,
)

if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(auth.router, prefix=settings.API_V1_STR)
app.include_router(servers.router, prefix=settings.API_V1_STR)
app.include_router(jobs.router, prefix=settings.API_V1_STR)
app.include_router(schedules.router, prefix=settings.API_V1_STR)
app.include_router(reports.router, prefix=settings.API_V1_STR)
app.include_router(audit.router, prefix=settings.API_V1_STR)
app.include_router(users.router, prefix=settings.API_V1_STR)
app.include_router(health_router.router, prefix=settings.API_V1_STR)
app.include_router(stream.router, prefix=settings.API_V1_STR)


@app.get("/", include_in_schema=False)
def root():
    return {"message": "Enterprise OS Patching & Update Platform API is active"}


@app.get(f"{settings.API_V1_STR}/health/live", include_in_schema=False)
def health_live():
    return {"status": "alive"}


@app.get(f"{settings.API_V1_STR}/health/ready", include_in_schema=False)
def health_ready():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:
        logger.error("Database readiness check failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Database is unavailable") from exc
    return {"status": "ready"}
