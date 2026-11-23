import os
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "unit-test-secret-key-at-least-32-characters-long")
os.environ.setdefault("BOOTSTRAP_ADMIN_PASSWORD", "UnitTestAdminPass123!")

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.auth import change_own_password, login, update_own_profile
from app.api.jobs import export_job_csv, get_job_by_build_id, get_jobs, launch_update_job
from app.api.reports import get_dashboard_summary
from app.api.schedules import create_schedule, get_schedules
from app.api.servers import get_servers, reboot_server
from app.api.stream import build_job_snapshot_payload, compute_fleet_watermark
from app.api.users import UserUpdate, create_user, update_user
from app.database import Base
from app.models.models import (
    AuditLog,
    ConnectionStatusEnum,
    OSFamilyEnum,
    RoleEnum,
    Server,
    ServerGroup,
    UpdateTypeEnum,
    User,
)
from app.schemas.schemas import (
    JobCreate,
    ScheduleCreate,
    SelfPasswordChange,
    SelfProfileUpdate,
    UserCreate,
    UserLogin,
)
from app.services.auth_service import get_current_user, get_password_hash
from app.services.job_executor import create_job_record, utcnow
from app.worker import process_due_schedules


def _mock_request(ip: str = "10.20.30.99") -> MagicMock:
    req = MagicMock()
    req.headers = {"x-real-ip": ip, "x-forwarded-proto": "https"}
    req.url.scheme = "https"
    req.client.host = ip
    return req


class SectionDRbacAndUxTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.SessionLocal()

        self.group_a = ServerGroup(name="Customer Alpha", description="Tenant A")
        self.group_b = ServerGroup(name="Customer Beta", description="Tenant B")
        self.db.add_all([self.group_a, self.group_b])
        self.db.flush()

        self.srv_a_linux = Server(
            hostname="alpha-linux-01",
            ip_address="10.10.0.11",
            os_family=OSFamilyEnum.LINUX,
            group_id=self.group_a.id,
            awx_credential_id=1,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=4,
            security_updates_count=2,
            last_discovered_at=utcnow(),
            is_managed=True,
        )
        self.srv_a_win = Server(
            hostname="alpha-win-01",
            ip_address="10.10.0.12",
            os_family=OSFamilyEnum.WINDOWS,
            group_id=self.group_a.id,
            awx_credential_id=2,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=3,
            security_updates_count=1,
            last_discovered_at=utcnow(),
            is_managed=True,
        )
        self.srv_b_linux = Server(
            hostname="beta-linux-01",
            ip_address="10.20.0.11",
            os_family=OSFamilyEnum.LINUX,
            group_id=self.group_b.id,
            awx_credential_id=1,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=5,
            security_updates_count=5,
            last_discovered_at=utcnow(),
            is_managed=True,
        )
        self.db.add_all([self.srv_a_linux, self.srv_a_win, self.srv_b_linux])

        self.admin = User(
            username="rootadmin",
            email="rootadmin@patchops.local",
            password_hash=get_password_hash("RootAdminPass123!"),
            role=RoleEnum.ADMIN,
            is_active=True,
            token_version=0,
        )
        self.db.add(self.admin)
        self.db.commit()

        # Create a scoped operator restricted strictly to Customer Alpha + Linux only
        self.scoped_operator = create_user(
            UserCreate(
                username="alpha_linux_eng",
                email="alpha.linux@patchops.local",
                password="AlphaLinuxPass123!",
                full_name="Alpha Linux Engineer",
                role=RoleEnum.OPERATOR,
                allowed_group_ids=[self.group_a.id],
                allowed_os_families=["linux"],
            ),
            db=self.db,
            current_user=self.admin,
        )

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_self_service_profile_and_password_change_keeps_current_session_and_revokes_old(self):
        req = _mock_request()
        res1 = MagicMock()
        tok1 = login(
            UserLogin(username="alpha_linux_eng", password="AlphaLinuxPass123!"),
            request=req,
            response=res1,
            db=self.db,
        )["access_token"]

        updated_profile = update_own_profile(
            SelfProfileUpdate(full_name="Senior Linux SRE", email="sre.linux@patchops.local"),
            request=req,
            db=self.db,
            current_user=self.scoped_operator,
        )
        self.assertEqual(updated_profile.full_name, "Senior Linux SRE")
        self.assertEqual(updated_profile.email, "sre.linux@patchops.local")

        # Wrong current password must fail with 400
        with self.assertRaises(HTTPException) as bad_pw:
            change_own_password(
                SelfPasswordChange(current_password="WrongCurrentPass!", new_password="NewSecurePassword123!"),
                request=req,
                response=MagicMock(),
                db=self.db,
                current_user=self.scoped_operator,
            )
        self.assertEqual(bad_pw.exception.status_code, 400)

        # Valid self-service password change issues new token and invalidates tok1
        res2 = MagicMock()
        changed = change_own_password(
            SelfPasswordChange(current_password="AlphaLinuxPass123!", new_password="NewSecurePassword123!"),
            request=req,
            response=res2,
            db=self.db,
            current_user=self.scoped_operator,
        )
        tok2 = changed["access_token"]

        with self.assertRaises(HTTPException) as old_tok_err:
            get_current_user(token=tok1, db=self.db)
        self.assertEqual(old_tok_err.exception.status_code, 401)

        self.assertEqual(get_current_user(token=tok2, db=self.db).username, "alpha_linux_eng")
        actions = {a.action for a in self.db.query(AuditLog).filter(AuditLog.username == "alpha_linux_eng").all()}
        self.assertIn("UPDATE_PROFILE", actions)
        self.assertIn("CHANGE_PASSWORD", actions)

    def test_scoped_rbac_enforces_customer_and_os_boundaries_everywhere(self):
        # 1. Server visibility: scoped operator only sees alpha-linux-01
        visible_servers = get_servers(offset=0, limit=100, search=None, db=self.db, current_user=self.scoped_operator)
        self.assertEqual([s.hostname for s in visible_servers], ["alpha-linux-01"])

        # 2. Dashboard summary reflects ONLY Customer Alpha Linux metrics
        summary = get_dashboard_summary(db=self.db, current_user=self.scoped_operator)
        self.assertEqual(summary.total_servers, 1)
        self.assertEqual(summary.security_updates_available, 2)
        self.assertEqual(len(summary.customer_summaries), 1)
        self.assertEqual(summary.customer_summaries[0].name, "Customer Alpha")
        self.assertEqual(summary.customer_summaries[0].total_servers, 1)

        # 3. Attempting to patch Windows host in same customer -> 403 Forbidden
        with self.assertRaises(HTTPException) as win_denied:
            launch_update_job(
                JobCreate(
                    job_name="Unauthorized Windows Patch",
                    update_type=UpdateTypeEnum.SECURITY,
                    server_ids=[self.srv_a_win.id],
                ),
                db=self.db,
                current_user=self.scoped_operator,
            )
        self.assertEqual(win_denied.exception.status_code, 403)

        # 4. Attempting to reboot Linux host in Customer Beta -> 403 Forbidden
        with self.assertRaises(HTTPException) as beta_denied:
            reboot_server(
                server_id=self.srv_b_linux.id,
                request=_mock_request(),
                action="reboot",
                allow_overlap=False,
                db=self.db,
                current_user=self.scoped_operator,
            )
        self.assertEqual(beta_denied.exception.status_code, 403)

        # 5. Admin launches a job on Customer Beta; scoped operator cannot view it
        beta_job = launch_update_job(
            JobCreate(
                job_name="Beta Security Run",
                update_type=UpdateTypeEnum.SECURITY,
                server_ids=[self.srv_b_linux.id],
            ),
            db=self.db,
            current_user=self.admin,
        )
        with self.assertRaises(HTTPException) as job_denied:
            get_job_by_build_id(beta_job.build_id, db=self.db, current_user=self.scoped_operator)
        self.assertEqual(job_denied.exception.status_code, 403)

        # 6. Scoped operator CAN launch a job on their allowed alpha-linux-01 host
        allowed_job = launch_update_job(
            JobCreate(
                job_name="Alpha Linux Security Run",
                update_type=UpdateTypeEnum.SECURITY,
                server_ids=[self.srv_a_linux.id],
            ),
            db=self.db,
            current_user=self.scoped_operator,
        )
        self.assertTrue(allowed_job.build_id.startswith("RUN-"))
        scoped_jobs = get_jobs(search=None, offset=0, limit=50, db=self.db, current_user=self.scoped_operator)
        self.assertEqual([j.build_id for j in scoped_jobs], [allowed_job.build_id])

        # 7. Promoting user to administrator clears restrictions automatically
        promoted = update_user(
            self.scoped_operator.id,
            UserUpdate(role=RoleEnum.ADMIN),
            db=self.db,
            current_user=self.admin,
        )
        self.assertIsNone(promoted.allowed_group_ids)
        self.assertIsNone(promoted.allowed_os_families)

    def test_run_id_prefix_and_clean_csv_export_naming(self):
        new_job = create_job_record(
            self.db,
            job_name="Standardize Run ID Test",
            update_type=UpdateTypeEnum.REGULAR,
            servers=[self.srv_a_linux],
            initiated_by="rootadmin",
        )
        self.db.commit()
        self.assertTrue(new_job.build_id.startswith("RUN-"))
        self.assertNotIn("#", new_job.build_id)

        csv_resp = export_job_csv(new_job.build_id, db=self.db, current_user=self.admin)
        disp = csv_resp.headers["Content-Disposition"]
        self.assertIn('filename="run-', disp)
        self.assertNotIn("build-", disp)
        body_text = csv_resp.body.decode("utf-8")
        self.assertTrue(body_text.startswith("Run ID,Job Name"))

    def test_recurring_discovery_schedule_and_sse_helpers(self):
        sched = create_schedule(
            ScheduleCreate(
                name="Every 6h Discovery Scan",
                update_type=UpdateTypeEnum.DISCOVERY,
                target_servers=[self.srv_a_linux.id],
                cron_expression="0 */6 * * *",
                timezone="UTC",
                maintenance_window_mins=60,
                prevent_overlap=True,
            ),
            request=_mock_request(),
            db=self.db,
            current_user=self.scoped_operator,
        )
        self.assertEqual(sched.update_type, UpdateTypeEnum.DISCOVERY)
        visible_scheds = get_schedules(db=self.db, current_user=self.scoped_operator)
        self.assertEqual(len(visible_scheds), 1)

        # Trigger due schedule via worker and verify SSE watermark + job snapshot
        wm_before = compute_fleet_watermark(self.db, self.scoped_operator)
        sched.next_run_at = utcnow() - timedelta(minutes=1)
        self.db.commit()

        process_due_schedules(self.db, now=utcnow())
        wm_after = compute_fleet_watermark(self.db, self.scoped_operator)
        self.assertNotEqual(wm_before, wm_after)

        jobs = get_jobs(search=None, offset=0, limit=50, db=self.db, current_user=self.scoped_operator)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].update_type, UpdateTypeEnum.DISCOVERY)

        snapshot = build_job_snapshot_payload(self.db, jobs[0].build_id)
        self.assertIsNotNone(snapshot)
        payload, digest, is_terminal = snapshot
        self.assertEqual(payload["job"]["build_id"], jobs[0].build_id)
        self.assertTrue(len(digest) > 10)
        self.assertFalse(is_terminal)


if __name__ == "__main__":
    unittest.main()
