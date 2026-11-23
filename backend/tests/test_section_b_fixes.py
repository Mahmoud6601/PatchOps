import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

os.environ.setdefault("SECRET_KEY", "unit-test-secret-key-that-is-at-least-32-bytes")
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("AWX_URL", "")
os.environ.setdefault("AWX_TOKEN", "")

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.models import (
    AuditLog,
    ConnectionStatusEnum,
    InstalledPatch,
    JobServer,
    JobStatusEnum,
    OSFamilyEnum,
    RoleEnum,
    Schedule,
    Server,
    UpdateJob,
    UpdateTypeEnum,
    User,
)
from app.schemas.schemas import JobCreate
from app.api import auth as auth_api
from app.api.users import UserUpdate, update_user
from app.api.servers import (
    BulkServersRequest,
    bulk_reboot_servers,
    bulk_reset_windows_cache,
    get_server_installed_patches,
    reboot_server,
    reset_windows_cache,
)
from app.api.jobs import get_job_installed_patches, launch_update_job, retry_failed_job
from app.services.job_executor import create_job_record, process_awx_events
from app.worker import process_due_schedules


class TestSectionBFixes(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        Base.metadata.create_all(bind=self.engine)
        self.db = TestingSessionLocal()

        self.admin = User(
            username="admin",
            email="admin@patchops.local",
            password_hash="fakehash",
            role=RoleEnum.ADMIN,
            is_active=True,
        )
        self.operator = User(
            username="ops1",
            email="ops1@patchops.local",
            password_hash="fakehash",
            role=RoleEnum.OPERATOR,
            is_active=True,
        )
        self.db.add_all([self.admin, self.operator])
        self.db.commit()

        self.mock_request = MagicMock()
        self.mock_request.client.host = "127.0.0.1"

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)

    # Item #1 & Item #6: RoleEnum.ADMIN fix + email normalization & duplicate prevention
    def test_admin_self_update_and_email_duplicate_validation(self):
        updated = update_user(
            user_id=self.admin.id,
            user_in=UserUpdate(full_name="Chief Admin", email="", role=RoleEnum.ADMIN),
            db=self.db,
            current_user=self.admin,
        )
        self.assertEqual(updated.full_name, "Chief Admin")
        self.assertIsNone(updated.email)

        # Self-demotion must return clean 400 (not 500 AttributeError)
        with self.assertRaises(HTTPException) as ctx:
            update_user(
                user_id=self.admin.id,
                user_in=UserUpdate(role=RoleEnum.OPERATOR),
                db=self.db,
                current_user=self.admin,
            )
        self.assertEqual(ctx.exception.status_code, 400)

        # Duplicate email across different users must return clean 400 (not 500 IntegrityError)
        with self.assertRaises(HTTPException) as dup_ctx:
            update_user(
                user_id=self.admin.id,
                user_in=UserUpdate(email="ops1@patchops.local"),
                db=self.db,
                current_user=self.admin,
            )
        self.assertEqual(dup_ctx.exception.status_code, 400)

    # Item #7: Duplicate unaudited /auth/register route removed
    def test_duplicate_auth_register_route_is_removed(self):
        route_paths = {getattr(r, "path", "") for r in auth_api.router.routes}
        self.assertNotIn("/auth/register", route_paths)
        self.assertIn("/auth/login", route_paths)
        self.assertIn("/auth/me", route_paths)

    # Item #2: Overlap protection enforced across reboot, cache reset, and retry-failed
    def test_overlap_protection_enforced_on_direct_actions_and_retry(self):
        win_srv = Server(
            hostname="win-prod-01",
            ip_address="10.20.0.40",
            os_family=OSFamilyEnum.WINDOWS,
            package_manager="windows_update",
            awx_credential_id=5,
            connection_status=ConnectionStatusEnum.ONLINE,
            is_managed=True,
        )
        self.db.add(win_srv)
        self.db.commit()

        # Simulate a finished failed job + a currently running job on win-prod-01
        failed_job = create_job_record(
            self.db,
            job_name="Previous Failed Run",
            update_type=UpdateTypeEnum.SECURITY,
            servers=[win_srv],
            initiated_by="ops1",
        )
        failed_job.status = JobStatusEnum.FAILED
        failed_job.server_records[0].status = JobStatusEnum.FAILED

        running_job = create_job_record(
            self.db,
            job_name="Active Patching Run",
            update_type=UpdateTypeEnum.REGULAR,
            servers=[win_srv],
            initiated_by="admin",
        )
        running_job.status = JobStatusEnum.RUNNING
        running_job.server_records[0].status = JobStatusEnum.RUNNING
        self.db.commit()

        # Single reboot blocked with 409
        with self.assertRaises(HTTPException) as c1:
            reboot_server(win_srv.id, self.mock_request, action="reboot", allow_overlap=False, db=self.db, current_user=self.operator)
        self.assertEqual(c1.exception.status_code, 409)

        # Bulk reboot blocked with 409
        with self.assertRaises(HTTPException) as c2:
            bulk_reboot_servers(BulkServersRequest(server_ids=[win_srv.id]), self.mock_request, db=self.db, current_user=self.operator)
        self.assertEqual(c2.exception.status_code, 409)

        # Reset Windows cache blocked with 409
        with self.assertRaises(HTTPException) as c3:
            reset_windows_cache(win_srv.id, allow_overlap=False, db=self.db, current_user=self.operator)
        self.assertEqual(c3.exception.status_code, 409)

        # Bulk reset cache blocked with 409
        with self.assertRaises(HTTPException) as c4:
            bulk_reset_windows_cache(BulkServersRequest(server_ids=[win_srv.id]), db=self.db, current_user=self.operator)
        self.assertEqual(c4.exception.status_code, 409)

        # Retry failed blocked with 409 when another job is actively running on target
        with self.assertRaises(HTTPException) as c5:
            retry_failed_job(failed_job.build_id, all_batch=False, allow_overlap=False, db=self.db, current_user=self.operator)
        self.assertEqual(c5.exception.status_code, 409)

        # Operator cannot force allow_overlap=True (403)
        with self.assertRaises(HTTPException) as c6:
            reboot_server(win_srv.id, self.mock_request, action="reboot", allow_overlap=True, db=self.db, current_user=self.operator)
        self.assertEqual(c6.exception.status_code, 403)

    # Item #3: Clearing pending reboot flag does NOT create ghost UpdateJob records
    def test_clear_reboot_flag_does_not_create_ghost_jobs(self):
        srv = Server(
            hostname="linux-reboot-flag",
            ip_address="10.20.0.41",
            os_family=OSFamilyEnum.LINUX,
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            reboot_required=True,
            reboot_status_known=True,
            is_managed=True,
        )
        self.db.add(srv)
        self.db.commit()

        before_jobs = self.db.query(UpdateJob).count()
        resp = reboot_server(srv.id, self.mock_request, action="clear_flag", allow_overlap=False, db=self.db, current_user=self.operator)
        self.assertEqual(resp.status_code, 200)
        self.db.refresh(srv)
        self.assertFalse(srv.reboot_required)
        self.assertEqual(self.db.query(UpdateJob).count(), before_jobs)

        srv.reboot_required = True
        self.db.commit()
        resp_bulk = bulk_reboot_servers(
            BulkServersRequest(server_ids=[srv.id], action="clear_flag"),
            self.mock_request,
            db=self.db,
            current_user=self.operator,
        )
        self.assertEqual(resp_bulk.status_code, 200)
        self.assertEqual(self.db.query(UpdateJob).count(), before_jobs)

    # Item #4: Schedule runner assigns batch_id on mixed targets and skips missing credentials safely
    def test_schedule_runner_assigns_batch_id_and_handles_missing_credentials(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        s_linux = Server(hostname="sched-lin", ip_address="10.0.0.1", os_family=OSFamilyEnum.LINUX, awx_credential_id=1, is_managed=True)
        s_win = Server(hostname="sched-win", ip_address="10.0.0.2", os_family=OSFamilyEnum.WINDOWS, awx_credential_id=2, is_managed=True)
        s_unconf = Server(hostname="sched-nocred", ip_address="10.0.0.3", os_family=OSFamilyEnum.LINUX, awx_credential_id=None, is_managed=True)
        self.db.add_all([s_linux, s_win, s_unconf])
        self.db.commit()

        sched = Schedule(
            name="Nightly Multi-OS Policy",
            update_type=UpdateTypeEnum.SECURITY,
            target_servers=[s_linux.id, s_win.id, s_unconf.id],
            scheduled_time=now - timedelta(minutes=1),
            next_run_at=now - timedelta(minutes=1),
            maintenance_window_mins=60,
            is_active=True,
            prevent_overlap=True,
            created_by="admin",
        )
        self.db.add(sched)
        self.db.commit()

        process_due_schedules(self.db, now=now)

        jobs = self.db.query(UpdateJob).order_by(UpdateJob.id.asc()).all()
        self.assertEqual(len(jobs), 2)
        self.assertIsNotNone(jobs[0].batch_id)
        self.assertEqual(jobs[0].batch_id, jobs[1].batch_id)

        partial_audit = self.db.query(AuditLog).filter(AuditLog.action == "SCHEDULE_PARTIAL_SKIP").first()
        self.assertIsNotNone(partial_audit)
        self.assertIn("sched-nocred", partial_audit.details)

    # Item #5: InstalledPatch API endpoints for Server and Job/Batch
    def test_installed_patches_api_endpoints(self):
        srv = Server(hostname="patch-host", ip_address="10.0.0.11", os_family=OSFamilyEnum.LINUX, awx_credential_id=1, is_managed=True)
        self.db.add(srv)
        self.db.commit()

        job = create_job_record(
            self.db,
            job_name="Security Run",
            update_type=UpdateTypeEnum.SECURITY,
            servers=[srv],
            initiated_by="admin",
        )
        self.db.add_all([
            InstalledPatch(job_id=job.id, server_id=srv.id, package_or_kb="openssl-3.0.13", patch_type="security"),
            InstalledPatch(job_id=job.id, server_id=srv.id, package_or_kb="KB5034441", patch_type="security"),
        ])
        self.db.commit()

        srv_patches = get_server_installed_patches(srv.id, search="openssl", limit=50, db=self.db, current_user=self.admin)
        self.assertEqual(len(srv_patches), 1)
        self.assertEqual(srv_patches[0].package_or_kb, "openssl-3.0.13")
        self.assertEqual(srv_patches[0].build_id, job.build_id)

        job_patches = get_job_installed_patches(job.build_id, db=self.db, current_user=self.admin)
        self.assertEqual(len(job_patches), 2)

    # Item #8: Reboot-only and cache-reset jobs never overwrite pending_updates_count
    def test_reboot_only_never_overwrites_pending_update_counts(self):
        srv = Server(
            hostname="win-pending-host",
            ip_address="10.0.0.25",
            os_family=OSFamilyEnum.WINDOWS,
            awx_credential_id=5,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=14,
            security_updates_count=4,
            reboot_required=True,
            is_managed=True,
        )
        self.db.add(srv)
        self.db.commit()

        job = create_job_record(
            self.db,
            job_name="Reboot Action",
            update_type=UpdateTypeEnum.REGULAR,
            servers=[srv],
            initiated_by="admin",
            reboot_only=True,
        )
        self.db.commit()

        # Even if a stray Verification event arrived with pending_updates: 0, counts must remain intact
        process_awx_events(self.db, job, [
            {
                "id": 901,
                "event": "runner_on_ok",
                "task": "Stage 5: Verification - emit Windows patch result",
                "event_data": {
                    "host": "win-pending-host",
                    "task": "Stage 5: Verification - emit Windows patch result",
                    "res": {
                        "msg": {
                            "stage": "Verification",
                            "status": "Success",
                            "pending_updates": 0,
                            "security_updates": 0,
                        }
                    },
                },
            }
        ])
        self.db.refresh(srv)
        self.assertEqual(srv.pending_updates_count, 14)
        self.assertEqual(srv.security_updates_count, 4)

    # Item #9: Major OS Upgrade validation enforces Admin + confirmations + Linux-only targets
    def test_major_upgrade_requires_linux_targets(self):
        win_srv = Server(
            hostname="win-no-major",
            ip_address="10.0.0.99",
            os_family=OSFamilyEnum.WINDOWS,
            package_manager="windows_update",
            awx_credential_id=5,
            connection_status=ConnectionStatusEnum.ONLINE,
            is_managed=True,
        )
        self.db.add(win_srv)
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            launch_update_job(
                JobCreate(
                    job_name="Major Upgrade Attempt",
                    update_type=UpdateTypeEnum.MAJOR_UPGRADE,
                    server_ids=[win_srv.id],
                    confirm_major_upgrade=True,
                    backup_verified=True,
                ),
                db=self.db,
                current_user=self.admin,
            )
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
