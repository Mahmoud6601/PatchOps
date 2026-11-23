import os
import sys
import unittest
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

from app.api.auth import login, logout, refresh_access_token
from app.api.users import PasswordReset, UserUpdate, reset_user_password, update_user
from app.database import Base
from app.models.models import AuditLog, OSFamilyEnum, RevokedToken, RoleEnum, Server, User
from app.schemas.schemas import UserLogin
from app.services.auth_service import REFRESH_COOKIE_NAME, get_current_user, get_password_hash
from app.services.awx_client import AWXClient


def _make_mock_request(ip: str = "10.20.30.134", proto: str = "https") -> MagicMock:
    req = MagicMock()
    req.headers = {"x-real-ip": ip, "x-forwarded-proto": proto}
    req.url.scheme = proto
    req.client.host = ip
    return req


class SectionCSecurityHardeningTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.db = self.SessionLocal()

        self.admin = User(
            username="secadmin",
            full_name="Security Admin",
            email="secadmin@patchops.local",
            password_hash=get_password_hash("CorrectHorseBatteryStaple!9"),
            role=RoleEnum.ADMIN,
            is_active=True,
            token_version=0,
        )
        self.operator = User(
            username="opsuser",
            full_name="Ops User",
            email="opsuser@patchops.local",
            password_hash=get_password_hash("OperatorSecurePass!9"),
            role=RoleEnum.OPERATOR,
            is_active=True,
            token_version=0,
        )
        self.db.add_all([self.admin, self.operator])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_login_records_audit_log_and_sets_httponly_refresh_cookie(self):
        req = _make_mock_request(ip="10.20.30.55", proto="https")
        res = MagicMock()

        result = login(
            UserLogin(username="secadmin", password="CorrectHorseBatteryStaple!9"),
            request=req,
            response=res,
            db=self.db,
        )
        self.assertIn("access_token", result)
        res.set_cookie.assert_called_once()
        cookie_kwargs = res.set_cookie.call_args.kwargs
        self.assertEqual(cookie_kwargs["key"], REFRESH_COOKIE_NAME)
        self.assertTrue(cookie_kwargs["httponly"])
        self.assertTrue(cookie_kwargs["secure"])

        audit = self.db.query(AuditLog).filter(AuditLog.action == "LOGIN").one()
        self.assertEqual(audit.username, "secadmin")
        self.assertEqual(audit.ip_address, "10.20.30.55")

    def test_brute_force_login_locks_out_after_five_failures_and_audits_lockout(self):
        req = _make_mock_request(ip="10.20.30.250", proto="https")
        res = MagicMock()

        for _ in range(5):
            with self.assertRaises(HTTPException) as ctx:
                login(
                    UserLogin(username="secadmin", password="WrongPassword!"),
                    request=req,
                    response=res,
                    db=self.db,
                )
            self.assertEqual(ctx.exception.status_code, 401)

        failed_logs = self.db.query(AuditLog).filter(AuditLog.action == "LOGIN_FAILED").count()
        self.assertEqual(failed_logs, 5)

        # 6th attempt must be blocked with 429 even if password is correct
        with self.assertRaises(HTTPException) as lock_ctx:
            login(
                UserLogin(username="secadmin", password="CorrectHorseBatteryStaple!9"),
                request=req,
                response=res,
                db=self.db,
            )
        self.assertEqual(lock_ctx.exception.status_code, 429)

        locked_logs = self.db.query(AuditLog).filter(AuditLog.action == "LOGIN_LOCKED").all()
        self.assertEqual(len(locked_logs), 1)
        self.assertEqual(locked_logs[0].ip_address, "10.20.30.250")

    def test_refresh_rotation_and_logout_token_blacklist(self):
        req = _make_mock_request(ip="10.20.30.77", proto="https")
        res = MagicMock()

        login_res = login(
            UserLogin(username="secadmin", password="CorrectHorseBatteryStaple!9"),
            request=req,
            response=res,
            db=self.db,
        )
        initial_access = login_res["access_token"]
        initial_refresh = res.set_cookie.call_args.kwargs["value"]

        # Refresh rotates refresh token and blacklists the old refresh JTI
        refresh_res_mock = MagicMock()
        refreshed = refresh_access_token(
            request=req,
            response=refresh_res_mock,
            patching_refresh_token=initial_refresh,
            db=self.db,
        )
        second_access = refreshed["access_token"]
        second_refresh = refresh_res_mock.set_cookie.call_args.kwargs["value"]

        # Replaying old refresh token must fail with 401
        with self.assertRaises(HTTPException) as replay_ctx:
            refresh_access_token(
                request=req,
                response=MagicMock(),
                patching_refresh_token=initial_refresh,
                db=self.db,
            )
        self.assertEqual(replay_ctx.exception.status_code, 401)

        # Logout revokes both active access token and refresh token
        logout_res_mock = MagicMock()
        current = get_current_user(token=second_access, db=self.db)
        logout(
            request=req,
            response=logout_res_mock,
            token=second_access,
            patching_refresh_token=second_refresh,
            db=self.db,
            current_user=current,
        )

        with self.assertRaises(HTTPException) as revoked_access_ctx:
            get_current_user(token=second_access, db=self.db)
        self.assertEqual(revoked_access_ctx.exception.status_code, 401)

        logout_audit = self.db.query(AuditLog).filter(AuditLog.action == "LOGOUT").one()
        self.assertEqual(logout_audit.username, "secadmin")
        self.assertGreaterEqual(self.db.query(RevokedToken).count(), 3)

    def test_password_reset_and_deactivation_invalidate_existing_tokens(self):
        req = _make_mock_request()
        res = MagicMock()
        ops_login = login(
            UserLogin(username="opsuser", password="OperatorSecurePass!9"),
            request=req,
            response=res,
            db=self.db,
        )
        ops_token = ops_login["access_token"]
        self.assertEqual(get_current_user(token=ops_token, db=self.db).username, "opsuser")

        # Admin resets operator password -> token_version increments -> old token immediately rejected
        reset_user_password(
            user_id=self.operator.id,
            body=PasswordReset(new_password="BrandNewOperatorPass!9"),
            db=self.db,
            current_user=self.admin,
        )
        with self.assertRaises(HTTPException) as reset_ctx:
            get_current_user(token=ops_token, db=self.db)
        self.assertEqual(reset_ctx.exception.status_code, 401)

        # Login again with new password, then deactivate user -> token invalidated again
        ops_login_2 = login(
            UserLogin(username="opsuser", password="BrandNewOperatorPass!9"),
            request=req,
            response=res,
            db=self.db,
        )
        ops_token_2 = ops_login_2["access_token"]
        update_user(
            user_id=self.operator.id,
            user_in=UserUpdate(is_active=False),
            db=self.db,
            current_user=self.admin,
        )
        with self.assertRaises(HTTPException) as deact_ctx:
            get_current_user(token=ops_token_2, db=self.db)
        self.assertEqual(deact_ctx.exception.status_code, 401)

    def test_per_server_winrm_cert_validation_propagates_to_awx_inventory(self):
        strict_win = Server(
            hostname="win-01",
            ip_address="10.20.0.50",
            os_family=OSFamilyEnum.WINDOWS,
            winrm_cert_validation="validate",
            is_managed=True,
        )
        workgroup_win = Server(
            hostname="win-02",
            ip_address="10.20.0.51",
            os_family=OSFamilyEnum.WINDOWS,
            winrm_cert_validation="ignore",
            is_managed=True,
        )
        inherited_win = Server(
            hostname="win-03",
            ip_address="10.20.0.52",
            os_family=OSFamilyEnum.WINDOWS,
            winrm_cert_validation=None,
            is_managed=True,
        )
        client = AWXClient()
        captured_payloads = []

        def fake_call(endpoint, method="GET", data=None, require_auth=True):
            if method == "GET" and "/hosts/" in endpoint:
                return {"results": [], "next": None}
            if method == "POST" and endpoint == "/hosts/":
                captured_payloads.append(data)
                return {"id": len(captured_payloads)}
            return {}

        with patch.object(client, "call", side_effect=fake_call):
            client.sync_inventory_hosts(2, [strict_win, workgroup_win, inherited_win])

        self.assertEqual(len(captured_payloads), 3)
        self.assertIn('"ansible_winrm_server_cert_validation": "validate"', captured_payloads[0]["variables"])
        self.assertIn('"ansible_winrm_server_cert_validation": "ignore"', captured_payloads[1]["variables"])
        # Default global policy in config.py is strict 'validate'
        self.assertIn('"ansible_winrm_server_cert_validation": "validate"', captured_payloads[2]["variables"])


if __name__ == "__main__":
    unittest.main()
