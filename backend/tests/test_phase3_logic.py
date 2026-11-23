import os
import unittest
from unittest.mock import patch, MagicMock

os.environ["SECRET_KEY"] = "unit-test-secret-key-that-is-at-least-32-bytes"
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AWX_URL"] = ""
os.environ["AWX_TOKEN"] = ""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.models import (
    Server,
    ServerGroup,
    User,
    RoleEnum,
    OSFamilyEnum,
    ConnectionStatusEnum,
)
from app.schemas.schemas import (
    ServerCreate,
    ServerGroupCreate,
    ServerGroupUpdate,
)
from app.api.servers import (
    create_server,
    create_server_group,
    update_server_group,
    get_server_groups,
    bulk_assign_server_group,
    get_awx_machine_credentials,
    BulkAssignGroupRequest,
)
from app.api.reports import get_dashboard_summary


class TestPhase3Logic(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        Base.metadata.create_all(bind=self.engine)
        self.db = TestingSessionLocal()

        self.admin_user = User(
            id=1,
            username="admin",
            password_hash="fakehash",
            role=RoleEnum.ADMIN,
            is_active=True,
        )
        self.db.add(self.admin_user)
        self.db.commit()

        self.mock_request = MagicMock()
        self.mock_request.client.host = "127.0.0.1"

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)

    @patch("app.api.servers._validate_awx_machine_credential")
    def test_group_creation_and_update_with_default_credentials(self, mock_validate):
        # 1. Create a customer group with default Linux and Windows credentials
        group_in = ServerGroupCreate(
            name="Acme Corp",
            description="Enterprise Client Acme",
            default_linux_credential_id=3,
            default_windows_credential_id=4,
        )
        created = create_server_group(group_in, self.mock_request, self.db, self.admin_user)
        self.assertEqual(created.name, "Acme Corp")
        self.assertEqual(created.default_linux_credential_id, 3)
        self.assertEqual(created.default_windows_credential_id, 4)

        # 2. Update the customer group
        update_in = ServerGroupUpdate(
            description="Updated Acme Corp SLA",
            default_windows_credential_id=5,
        )
        updated = update_server_group(created.id, update_in, self.mock_request, self.db, self.admin_user)
        self.assertEqual(updated.description, "Updated Acme Corp SLA")
        self.assertEqual(updated.default_linux_credential_id, 3)
        self.assertEqual(updated.default_windows_credential_id, 5)

        # Verify listed groups return default credentials
        all_groups = get_server_groups(self.db, self.admin_user)
        self.assertEqual(len(all_groups), 1)
        self.assertEqual(all_groups[0].default_linux_credential_id, 3)
        self.assertEqual(all_groups[0].default_windows_credential_id, 5)

    @patch("app.api.servers._validate_awx_machine_credential")
    def test_credential_inheritance_on_server_create(self, mock_validate):
        # Create group with defaults
        group = ServerGroup(
            name="Globex Financial",
            description="Banking customer",
            default_linux_credential_id=10,
            default_windows_credential_id=20,
        )
        self.db.add(group)
        self.db.commit()
        self.db.refresh(group)

        # 1. Add Linux server with NO credential specified -> should inherit 10
        server_linux_in = ServerCreate(
            hostname="linux-01",
            ip_address="10.10.1.11",
            os_family=OSFamilyEnum.LINUX,
            group_id=group.id,
        )
        created_linux = create_server(server_linux_in, self.mock_request, self.db, self.admin_user)
        self.assertEqual(created_linux.awx_credential_id, 10)

        # 2. Add Windows server with NO credential specified -> should inherit 20
        server_win_in = ServerCreate(
            hostname="win-01",
            ip_address="10.10.1.12",
            os_family=OSFamilyEnum.WINDOWS,
            group_id=group.id,
        )
        created_win = create_server(server_win_in, self.mock_request, self.db, self.admin_user)
        self.assertEqual(created_win.awx_credential_id, 20)

        # 3. Add server with EXPLICIT credential specified -> should NOT be overwritten
        server_explicit_in = ServerCreate(
            hostname="linux-02",
            ip_address="10.10.1.13",
            os_family=OSFamilyEnum.LINUX,
            awx_credential_id=99,
            group_id=group.id,
        )
        created_explicit = create_server(server_explicit_in, self.mock_request, self.db, self.admin_user)
        self.assertEqual(created_explicit.awx_credential_id, 99)

    def test_bulk_assign_group_credential_inheritance(self):
        group = ServerGroup(
            name="Initech Corp",
            default_linux_credential_id=101,
            default_windows_credential_id=202,
        )
        self.db.add(group)
        self.db.commit()

        s1 = Server(hostname="linux-03", ip_address="10.20.1.1", os_family=OSFamilyEnum.LINUX, is_managed=True)
        s2 = Server(hostname="win-02", ip_address="10.20.1.2", os_family=OSFamilyEnum.WINDOWS, is_managed=True)
        self.db.add_all([s1, s2])
        self.db.commit()

        # Bulk assign with apply_default_credentials=True
        req = BulkAssignGroupRequest(
            server_ids=[s1.id, s2.id],
            group_id=group.id,
            apply_default_credentials=True,
        )
        bulk_assign_server_group(req, self.db, self.admin_user)

        self.db.refresh(s1)
        self.db.refresh(s2)
        self.assertEqual(s1.group_id, group.id)
        self.assertEqual(s1.awx_credential_id, 101)
        self.assertEqual(s2.group_id, group.id)
        self.assertEqual(s2.awx_credential_id, 202)

    @patch("app.api.servers.awx_client.list_machine_credentials")
    def test_awx_credentials_os_classification(self, mock_creds):
        mock_creds.return_value = [
            {"id": 3, "name": "Linux-SSH-Credential"},
            {"id": 4, "name": "Win Ser"},
            {"id": 5, "name": "General Domain Admin"},
        ]
        creds = get_awx_machine_credentials(self.db, self.admin_user)
        self.assertEqual(len(creds), 3)

        c3 = next(c for c in creds if c.id == 3)
        self.assertEqual(c3.os_compatibility, "linux")

        c4 = next(c for c in creds if c.id == 4)
        self.assertEqual(c4.os_compatibility, "windows")

        c5 = next(c for c in creds if c.id == 5)
        self.assertEqual(c5.os_compatibility, "windows")

    def test_msp_customer_fleet_summary(self):
        # Create 2 groups: Group A (100% compliant) and Group B (Has pending updates & reboots)
        group_a = ServerGroup(name="Enterprise Alpha")
        group_b = ServerGroup(name="Enterprise Beta")
        self.db.add_all([group_a, group_b])
        self.db.commit()

        # Group A: 2 online servers, 0 pending
        s1 = Server(
            hostname="alpha-01",
            ip_address="10.1.1.1",
            group_id=group_a.id,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=0,
            security_updates_count=0,
            reboot_required=False,
            is_managed=True,
        )
        s2 = Server(
            hostname="alpha-02",
            ip_address="10.1.1.2",
            group_id=group_a.id,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=0,
            security_updates_count=0,
            reboot_required=False,
            is_managed=True,
        )

        # Group B: 1 server with pending security updates, 1 reboot required
        s3 = Server(
            hostname="beta-01",
            ip_address="10.2.1.1",
            group_id=group_b.id,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=5,
            security_updates_count=2,
            reboot_required=False,
            is_managed=True,
        )
        s4 = Server(
            hostname="beta-02",
            ip_address="10.2.1.2",
            group_id=group_b.id,
            connection_status=ConnectionStatusEnum.ONLINE,
            pending_updates_count=0,
            security_updates_count=0,
            reboot_required=True,
            is_managed=True,
        )
        self.db.add_all([s1, s2, s3, s4])
        self.db.commit()

        summary = get_dashboard_summary(self.db, self.admin_user)
        self.assertTrue(hasattr(summary, "customer_summaries"))
        summaries = summary.customer_summaries
        self.assertEqual(len(summaries), 2)

        sum_a = next(s for s in summaries if s.id == group_a.id)
        self.assertEqual(sum_a.total_servers, 2)
        self.assertEqual(sum_a.compliance_rate, 100.0)
        self.assertEqual(sum_a.health_status, "healthy")

        sum_b = next(s for s in summaries if s.id == group_b.id)
        self.assertEqual(sum_b.total_servers, 2)
        self.assertEqual(sum_b.security_updates_count, 2)
        self.assertEqual(sum_b.reboot_required_count, 1)
        self.assertEqual(sum_b.compliance_rate, 0.0)
        self.assertEqual(sum_b.health_status, "critical")


if __name__ == "__main__":
    unittest.main()
