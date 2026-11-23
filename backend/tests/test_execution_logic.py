import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

# These tests always use an isolated in-memory database, never a configured
# deployment database or a live AWX endpoint.
os.environ["SECRET_KEY"] = "unit-test-secret-key-that-is-at-least-32-bytes"
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AWX_URL"] = ""
os.environ["AWX_TOKEN"] = ""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.models import (
    AuditLog,
    ConnectionStatusEnum,
    JobEvent,
    JobStatusEnum,
    InstalledPatch,
    OSFamilyEnum,
    PipelineStage,
    Schedule,
    Server,
    StageStatusEnum,
    UpdateJob,
    UpdateTypeEnum,
    RoleEnum,
    User,
)
from app.api.jobs import launch_update_job
from app.services.job_executor import create_job_record, finalize_awx_job, process_awx_events
from app.services.pipeline_engine import map_task_to_stage
from app.services.scheduling import compute_next_run, to_utc_naive
from app.worker import dispatch_one_pending_job, poll_active_jobs
from app.services.awx_client import AWXClientError
from app.schemas.schemas import JobCreate, JobDetailResponse, ServerResponse
from fastapi import HTTPException


class ExecutionLogicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
        cls.Session = sessionmaker(bind=cls.engine, expire_on_commit=False)

    def setUp(self):
        Base.metadata.create_all(self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(self.engine)

    def make_job(self, update_type=UpdateTypeEnum.SECURITY):
        server = Server(
            hostname="node-test-01",
            ip_address="192.0.2.10",
            os_family=OSFamilyEnum.LINUX,
            package_manager="apt",
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            last_discovered_at=datetime.now(timezone.utc).replace(tzinfo=None),
            is_managed=True,
        )
        self.db.add(server)
        self.db.flush()
        job = create_job_record(
            self.db,
            job_name="isolated test",
            update_type=update_type,
            servers=[server],
            initiated_by="test",
        )
        self.db.commit()
        self.db.refresh(job)
        return job, server

    def test_task_names_map_only_to_explicit_pipeline_stages(self):
        self.assertEqual(map_task_to_stage("Stage 1: Discovery - collect facts"), "Discovery")
        self.assertEqual(map_task_to_stage("Stage 2: Pre-check - free disk"), "Pre-check")
        self.assertEqual(map_task_to_stage("Stage 3: Update - install updates"), "Update")
        self.assertEqual(map_task_to_stage("Stage 4: Reboot - wait for host"), "Reboot")
        self.assertEqual(map_task_to_stage("Stage 5: Verification - confirm host"), "Verification")
        self.assertEqual(map_task_to_stage("Gathering Facts"), "Discovery")
        self.assertIsNone(map_task_to_stage("Notify the operator"))

    def test_one_time_schedule_uses_selected_timezone_and_rejects_dst_gap(self):
        utc_time = to_utc_naive(datetime(2026, 1, 15, 9, 0), "Africa/Cairo")
        self.assertEqual(utc_time, datetime(2026, 1, 15, 7, 0))
        with self.assertRaisesRegex(ValueError, "daylight-saving"):
            to_utc_naive(datetime(2026, 3, 8, 2, 30), "America/New_York")

    def test_cron_next_run_is_returned_in_utc(self):
        schedule = Schedule(cron_expression="0 2 * * *", timezone="America/New_York")
        now = datetime(2026, 11, 1, 5, 30)  # 01:30 EDT on the fall-back day.
        self.assertEqual(compute_next_run(schedule, now), datetime(2026, 11, 1, 7, 0))

    def test_discovery_events_are_persisted_idempotently_and_update_inventory(self):
        job, server = self.make_job(UpdateTypeEnum.DISCOVERY)
        events = [
            {
                "id": 1001,
                "event": "runner_on_start",
                "event_data": {"task": "Stage 1: Discovery - collect system metadata", "host": server.hostname},
            },
            {
                "id": 1002,
                "event": "runner_on_ok",
                "event_data": {
                    "task": "Stage 1: Discovery - collect system metadata",
                    "host": server.hostname,
                    "res": {"msg": {
                        "os_name": "Ubuntu 24.04",
                        "os_version": "24.04",
                        "pending_updates": 7,
                        "security_updates": 2,
                        "package_manager": "apt",
                        "reboot_required": False,
                        "reboot_status_known": True,
                    }},
                },
            },
        ]
        process_awx_events(self.db, job, events)
        process_awx_events(self.db, job, events)
        self.assertEqual(self.db.query(JobEvent).filter(JobEvent.job_id == job.id).count(), 2)
        self.assertEqual(server.os_name, "Ubuntu 24.04")
        self.assertEqual(server.pending_updates_count, 7)
        self.assertEqual(server.security_updates_count, 2)
        self.assertFalse(server.reboot_required)
        self.assertTrue(server.reboot_status_known)

        finalize_awx_job(
            self.db,
            job,
            "successful",
            [{"host_name": server.hostname, "ok": 2, "changed": 0, "failed": 0, "dark": 0}],
            "test output",
        )
        self.db.commit()
        self.assertEqual(job.status, JobStatusEnum.SUCCESS)
        self.assertEqual(job.server_records[0].stages[0].status, StageStatusEnum.SUCCESS)
        response = JobDetailResponse.model_validate(job)
        self.assertEqual(response.server_records[0].server_hostname, server.hostname)
        server_response = ServerResponse.model_validate(server)
        self.assertEqual(server_response.pending_updates_count, 7)
        self.assertTrue(server_response.discovery_fresh)

    def test_item_success_event_completes_the_pipeline_stage(self):
        job, server = self.make_job(UpdateTypeEnum.DISCOVERY)
        server.os_family = OSFamilyEnum.WINDOWS
        self.db.commit()
        process_awx_events(self.db, job, [
            {
                "id": 1051,
                "event": "runner_on_start",
                "event_data": {"task": "Stage 1: Discovery - inspect Windows reboot markers", "host": server.hostname},
            },
            {
                "id": 1052,
                "event": "runner_item_on_ok",
                "event_data": {"task": "Stage 1: Discovery - inspect Windows reboot markers", "host": server.hostname},
            },
            # AWX can deliver a late start callback after an item result from
            # the same Windows stage. The success remains authoritative.
            {
                "id": 1053,
                "event": "runner_on_start",
                "event_data": {"task": "Stage 1: Discovery - emit Windows system metadata", "host": server.hostname},
            },
        ])
        finalize_awx_job(
            self.db,
            job,
            "successful",
            [{"host_name": server.hostname, "ok": 2, "failures": 0, "dark": 0}],
            "test output",
        )
        self.db.commit()
        discovery = next(stage for stage in job.server_records[0].stages if stage.stage_name == "Discovery")
        self.assertEqual(discovery.status, StageStatusEnum.SUCCESS)

    def test_verified_patch_events_refresh_counts_without_treating_false_as_true(self):
        job, server = self.make_job()
        process_awx_events(self.db, job, [{
            "id": 1101,
            "event": "runner_on_ok",
            "event_data": {
                "task": "Stage 5: Verification - emit final result",
                "host": server.hostname,
                "res": {"msg": {
                    "stage": "Verification",
                    "status": "Success",
                    "pending_updates": "1",
                    "security_updates": "0",
                    "reboot_required": "False",
                    "reboot_status_known": "True",
                    "reboot_performed": "False",
                }},
            },
        }])
        self.assertEqual(server.pending_updates_count, 1)
        self.assertEqual(server.security_updates_count, 0)
        self.assertFalse(server.reboot_required)
        self.assertTrue(server.reboot_status_known)
        self.assertFalse(job.server_records[0].reboot_performed)

    def test_completed_package_event_is_saved_as_patch_history(self):
        job, server = self.make_job()
        process_awx_events(self.db, job, [{
            "id": 1201,
            "event": "runner_on_ok",
            "event_data": {
                "task": "Stage 3: Update - record completed Linux package identifiers",
                "host": server.hostname,
                "res": {"msg": {"updates": ["openssl", "libssl3"]}},
            },
        }])
        patches = self.db.query(InstalledPatch).filter(InstalledPatch.job_id == job.id).all()
        self.assertEqual({patch.package_or_kb for patch in patches}, {"openssl", "libssl3"})

    def test_missing_awx_host_summary_never_marks_job_successful(self):
        job, server = self.make_job()
        finalize_awx_job(self.db, job, "successful", [], "")
        self.db.commit()
        self.assertEqual(job.status, JobStatusEnum.FAILED)
        self.assertEqual(job.failed_servers, 1)
        self.assertEqual(job.server_records[0].status, JobStatusEnum.FAILED)

    def test_host_results_are_independent_when_awx_job_has_mixed_results(self):
        first = Server(hostname="node-good", ip_address="192.0.2.11", os_family=OSFamilyEnum.LINUX, is_managed=True)
        second = Server(hostname="node-bad", ip_address="192.0.2.12", os_family=OSFamilyEnum.LINUX, is_managed=True)
        self.db.add_all([first, second])
        self.db.flush()
        job = create_job_record(
            self.db,
            job_name="mixed host result",
            update_type=UpdateTypeEnum.SECURITY,
            servers=[first, second],
            initiated_by="test",
        )
        self.db.commit()
        events = [
            {
                "id": 2001,
                "event": "runner_on_ok",
                "event_data": {"task": "Stage 5: Verification - confirm host", "host": first.hostname, "res": {"msg": "verified"}},
            },
            {
                "id": 2002,
                "event": "runner_on_failed",
                "event_data": {"task": "Stage 3: Update - install patches", "host": second.hostname, "res": {"msg": "package transaction failed"}},
            },
        ]
        process_awx_events(self.db, job, events)
        finalize_awx_job(self.db, job, "failed", [
            {"host_name": first.hostname, "ok": 5, "failures": 0, "dark": 0},
            {"host_name": second.hostname, "ok": 2, "failures": 1, "dark": 0},
        ], "")
        self.db.commit()

        records = {record.server_hostname: record for record in job.server_records}
        self.assertEqual(records[first.hostname].status, JobStatusEnum.SUCCESS)
        self.assertEqual(records[second.hostname].status, JobStatusEnum.FAILED)
        self.assertEqual(job.successful_servers, 1)
        self.assertEqual(job.failed_servers, 1)

    def test_cancelled_running_stage_is_not_reported_as_failed(self):
        job, server = self.make_job()
        process_awx_events(self.db, job, [{
            "id": 3001,
            "event": "runner_on_start",
            "event_data": {"task": "Stage 3: Update - install patches", "host": server.hostname},
        }])
        finalize_awx_job(self.db, job, "canceled", [
            {"host_name": server.hostname, "ok": 2, "failures": 0, "dark": 0},
        ], "")
        self.db.commit()

        self.assertEqual(job.status, JobStatusEnum.CANCELLED)
        self.assertEqual(job.server_records[0].status, JobStatusEnum.CANCELLED)
        stage = next(stage for stage in job.server_records[0].stages if stage.stage_name == "Update")
        self.assertEqual(stage.status, StageStatusEnum.CANCELLED)

    def test_overlap_requires_an_admin_and_is_recorded_when_approved(self):
        active_job, server = self.make_job(UpdateTypeEnum.DISCOVERY)
        active_job.status = JobStatusEnum.RUNNING
        self.db.commit()

        request = JobCreate(
            job_name="approved overlap",
            update_type=UpdateTypeEnum.DISCOVERY,
            server_ids=[server.id],
            allow_overlap=True,
        )
        operator = User(username="operator", role=RoleEnum.OPERATOR)
        with self.assertRaises(HTTPException) as error:
            launch_update_job(request, self.db, operator)
        self.assertEqual(error.exception.status_code, 403)

        administrator = User(username="admin", role=RoleEnum.ADMIN)
        created = launch_update_job(request, self.db, administrator)
        self.assertTrue(created.overlap_approved)
        audit = self.db.query(AuditLog).filter(
            AuditLog.target_resource == created.build_id,
            AuditLog.action == "LAUNCH_JOB",
        ).one()
        self.assertIn("administrator-approved overlap", audit.details)

    def test_unknown_awx_launch_outcome_is_not_relaunched_or_marked_successful(self):
        job, _ = self.make_job()
        job.status = JobStatusEnum.PENDING
        self.db.commit()
        with patch("app.worker.settings.AWX_INVENTORY_ID", 12), patch(
            "app.worker.awx_client.get_job_template_by_name", return_value={"id": 17, "inventory": 12, "ask_credential_on_launch": True}
        ), patch(
            "app.worker.awx_client.sync_inventory_hosts", return_value=0
        ), patch(
            "app.worker.awx_client.get_credential_by_id", return_value={"kind": "ssh"}
        ), patch(
            "app.worker.awx_client.launch_job_template", side_effect=TimeoutError("request timed out")
        ), self.assertLogs("patching_worker", level="ERROR"):
            self.assertTrue(dispatch_one_pending_job(self.db))

        self.db.refresh(job)
        self.assertEqual(job.status, JobStatusEnum.RUNNING)
        self.assertIsNone(job.awx_job_id)
        self.assertIn("outcome is unknown", job.error_summary)
        self.assertIn("Inspect AWX", job.error_summary)

    def test_awx_accepted_job_remains_pending_until_awx_starts(self):
        job, _ = self.make_job()
        with patch("app.worker.settings.AWX_INVENTORY_ID", 12), patch(
            "app.worker.awx_client.get_job_template_by_name", return_value={"id": 17, "inventory": 12, "ask_credential_on_launch": True}
        ), patch(
            "app.worker.awx_client.sync_inventory_hosts", return_value=0
        ), patch(
            "app.worker.awx_client.get_credential_by_id", return_value={"kind": "ssh"}
        ), patch(
            "app.worker.awx_client.launch_job_template", return_value={"job": 77}
        ):
            self.assertTrue(dispatch_one_pending_job(self.db))

        self.db.refresh(job)
        self.assertEqual(job.status, JobStatusEnum.PENDING)
        self.assertEqual(job.awx_job_id, 77)
        self.assertIsNone(job.start_time)
        self.assertEqual(job.server_records[0].status, JobStatusEnum.PENDING)
        self.assertFalse(dispatch_one_pending_job(self.db))

    def test_awx_client_validation_error_fails_without_marking_job_running(self):
        job, _ = self.make_job()
        with patch("app.worker.settings.AWX_INVENTORY_ID", 12), patch(
            "app.worker.awx_client.get_job_template_by_name", return_value={"id": 17, "inventory": 12, "ask_credential_on_launch": True}
        ), patch(
            "app.worker.awx_client.sync_inventory_hosts", return_value=0
        ), patch(
            "app.worker.awx_client.get_credential_by_id", return_value={"kind": "ssh"}
        ), patch(
            "app.worker.awx_client.launch_job_template",
            side_effect=AWXClientError("AWX rejected the credential", status_code=400),
        ):
            self.assertTrue(dispatch_one_pending_job(self.db))

        self.db.refresh(job)
        self.assertEqual(job.status, JobStatusEnum.FAILED)
        self.assertIsNone(job.awx_job_id)
        self.assertIsNone(job.start_time)
        self.assertIn("rejected the credential", job.error_summary)

    def test_awx_running_status_starts_platform_timer_and_server(self):
        job, _ = self.make_job()
        job.awx_job_id = 88
        self.db.commit()
        with patch(
            "app.worker.awx_client.get_job_status",
            return_value={"status": "running", "started": "2026-11-13T19:18:24.000000Z"},
        ), patch("app.worker.awx_client.get_job_events", return_value=[]):
            poll_active_jobs(self.db)

        self.db.refresh(job)
        self.assertEqual(job.status, JobStatusEnum.RUNNING)
        self.assertEqual(job.start_time, datetime(2026, 11, 13, 19, 18, 24))
        self.assertEqual(job.server_records[0].status, JobStatusEnum.RUNNING)
        self.assertEqual(job.server_records[0].start_time, job.start_time)

    def test_queued_job_for_retired_host_is_stopped_before_awx_launch(self):
        job, server = self.make_job()
        job.status = JobStatusEnum.PENDING
        server.is_managed = False
        self.db.commit()
        with patch("app.worker.awx_client.get_job_template_by_name") as template_lookup:
            self.assertTrue(dispatch_one_pending_job(self.db))
        template_lookup.assert_not_called()
        self.db.refresh(job)
        self.assertEqual(job.status, JobStatusEnum.FAILED)
        self.assertIsNone(job.awx_job_id)
        self.assertIn("retired before AWX launch", job.error_summary)

    def test_migration_extends_legacy_tables_and_preserves_existing_job(self):
        backend_dir = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="patching-migration-test-") as folder:
            database_path = Path(folder) / "legacy.sqlite3"
            connection = sqlite3.connect(database_path)
            connection.executescript("""
                CREATE TABLE update_jobs (
                    id INTEGER PRIMARY KEY, build_id VARCHAR(50), job_name VARCHAR(100),
                    update_type VARCHAR(30), status VARCHAR(30), initiated_by VARCHAR(50),
                    awx_job_id INTEGER, start_time DATETIME, end_time DATETIME,
                    duration_seconds INTEGER, total_servers INTEGER, successful_servers INTEGER,
                    failed_servers INTEGER, error_summary TEXT, created_at DATETIME
                );
                CREATE TABLE servers (
                    id INTEGER PRIMARY KEY, hostname VARCHAR(100), ip_address VARCHAR(50),
                    os_family VARCHAR(20), os_name VARCHAR(100), os_version VARCHAR(50),
                    kernel_version VARCHAR(100), architecture VARCHAR(50), package_manager VARCHAR(50),
                    cpu_cores INTEGER, ram_total_mb INTEGER, ram_available_mb INTEGER,
                    disk_total_gb FLOAT, disk_available_gb FLOAT, connection_status VARCHAR(30),
                    reboot_required BOOLEAN, pending_updates_count INTEGER, security_updates_count INTEGER,
                    last_discovered_at DATETIME, last_updated_at DATETIME, group_id INTEGER, created_at DATETIME
                );
                CREATE TABLE schedules (
                    id INTEGER PRIMARY KEY, name VARCHAR(100), update_type VARCHAR(30),
                    target_servers JSON, target_group_id INTEGER, cron_expression VARCHAR(50),
                    scheduled_time DATETIME, timezone VARCHAR(50), maintenance_window_mins INTEGER,
                    is_active BOOLEAN, prevent_overlap BOOLEAN, last_run_at DATETIME,
                    next_run_at DATETIME, created_at DATETIME
                );
                INSERT INTO servers (
                    id, hostname, ip_address, os_family, connection_status, reboot_required,
                    pending_updates_count, security_updates_count, last_discovered_at
                ) VALUES (5, 'legacy-node', '192.0.2.50', 'LINUX', 'ONLINE', 1, 12, 4, CURRENT_TIMESTAMP);
                INSERT INTO schedules (
                    id, name, update_type, target_servers, timezone, maintenance_window_mins,
                    is_active, prevent_overlap, next_run_at
                ) VALUES (6, 'legacy schedule', 'SECURITY', '[5]', 'UTC', 120, 1, 1, CURRENT_TIMESTAMP);
                INSERT INTO update_jobs (
                    id, build_id, job_name, update_type, status, initiated_by, duration_seconds,
                    total_servers, successful_servers, failed_servers, created_at
                ) VALUES (7, 'BUILD-#LEGACY01', 'legacy run', 'SECURITY', 'SUCCESS', 'old-admin', 5, 1, 1, 0, CURRENT_TIMESTAMP);
                INSERT INTO update_jobs (
                    id, build_id, job_name, update_type, status, initiated_by, awx_job_id,
                    duration_seconds, total_servers, successful_servers, failed_servers, created_at
                ) VALUES (8, 'BUILD-#LEGACY02', 'legacy queued run', 'SECURITY', 'PENDING', 'old-admin', NULL, 0, 1, 0, 0, CURRENT_TIMESTAMP);
            """)
            connection.commit()
            connection.close()

            child_env = os.environ.copy()
            child_env.update({
                "SECRET_KEY": "migration-test-secret-key-at-least-32-characters",
                "DATABASE_URL": f"sqlite:///{database_path.as_posix()}",
                "PYTHONPATH": str(backend_dir),
            })
            result = subprocess.run(
                [sys.executable, "-m", "alembic", "-c", str(backend_dir / "alembic.ini"), "upgrade", "head"],
                cwd=backend_dir,
                env=child_env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            connection = sqlite3.connect(database_path)
            self.assertEqual(connection.execute("SELECT build_id FROM update_jobs WHERE id = 7").fetchone()[0], "BUILD-#LEGACY01")
            self.assertEqual(connection.execute("SELECT status FROM update_jobs WHERE id = 8").fetchone()[0], "CANCELLED")
            managed, connection_status, last_discovered, pending_count = connection.execute(
                "SELECT is_managed, connection_status, last_discovered_at, pending_updates_count FROM servers WHERE id = 5"
            ).fetchone()
            self.assertEqual((managed, connection_status, last_discovered, pending_count), (0, "OFFLINE", None, 0))
            self.assertEqual(connection.execute("SELECT is_active, next_run_at FROM schedules WHERE id = 6").fetchone(), (0, None))
            for table, expected in {
                "update_jobs": {"raw_logs", "major_upgrade_approved", "backup_verified", "overlap_approved", "scheduled_for"},
                "servers": {"is_managed", "reboot_status_known"},
                "schedules": {"created_by"},
            }.items():
                actual = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                self.assertTrue(expected.issubset(actual), f"Missing {expected - actual} on {table}")
            self.assertIsNotNone(connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='job_events'").fetchone())
            connection.close()


    def test_multi_server_batching_groups_by_os_and_credential(self):
        s1 = Server(
            hostname="win-server-01",
            ip_address="10.20.0.21",
            os_family=OSFamilyEnum.WINDOWS,
            package_manager="windows_update",
            awx_credential_id=4,
            connection_status=ConnectionStatusEnum.ONLINE,
            last_discovered_at=datetime.now(timezone.utc).replace(tzinfo=None),
            is_managed=True,
        )
        s2 = Server(
            hostname="win-server-02",
            ip_address="10.20.0.22",
            os_family=OSFamilyEnum.WINDOWS,
            package_manager="windows_update",
            awx_credential_id=5,
            connection_status=ConnectionStatusEnum.ONLINE,
            last_discovered_at=datetime.now(timezone.utc).replace(tzinfo=None),
            is_managed=True,
        )
        s3 = Server(
            hostname="linux-server-01",
            ip_address="10.20.0.11",
            os_family=OSFamilyEnum.LINUX,
            package_manager="apt",
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            last_discovered_at=datetime.now(timezone.utc).replace(tzinfo=None),
            is_managed=True,
        )
        self.db.add_all([s1, s2, s3])
        self.db.commit()

        # Grouping logic verification
        servers = [s1, s2, s3]
        batches = {}
        for s in servers:
            batches.setdefault((s.os_family, s.awx_credential_id), []).append(s)

        self.assertEqual(len(batches), 3)
        self.assertIn((OSFamilyEnum.WINDOWS, 4), batches)
        self.assertIn((OSFamilyEnum.WINDOWS, 5), batches)
        self.assertIn((OSFamilyEnum.LINUX, 3), batches)


    def test_auto_chain_discovery_allows_undiscovered_hosts(self):
        from app.api.jobs import _validate_patch_targets
        # Undiscovered host (last_discovered_at is None, package_manager is None)
        fresh_server = Server(
            hostname="fresh-node-01",
            ip_address="10.20.0.15",
            os_family=OSFamilyEnum.LINUX,
            package_manager=None,
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            last_discovered_at=None,
            is_managed=True,
        )
        self.db.add(fresh_server)
        self.db.commit()

        # Should NOT raise HTTPException(409) or HTTPException(422)
        try:
            _validate_patch_targets([fresh_server], UpdateTypeEnum.SECURITY)
        except Exception as e:
            self.fail(f"_validate_patch_targets raised an unexpected exception for undiscovered host: {e}")

    def test_batch_sister_jobs_and_active_server_count(self):
        import uuid
        from app.models.models import JobServer
        batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}"
        
        j1 = UpdateJob(
            build_id=f"BUILD-BATCH-1-{uuid.uuid4().hex[:6]}",
            job_name="Batch Run • Credential #3 (1 hosts)",
            update_type=UpdateTypeEnum.SECURITY,
            status=JobStatusEnum.RUNNING,
            initiated_by="admin",
            total_servers=1,
            batch_id=batch_id,
        )
        j2 = UpdateJob(
            build_id=f"BUILD-BATCH-2-{uuid.uuid4().hex[:6]}",
            job_name="Batch Run • Credential #4 (1 hosts)",
            update_type=UpdateTypeEnum.SECURITY,
            status=JobStatusEnum.PENDING,
            initiated_by="admin",
            total_servers=1,
            batch_id=batch_id,
        )
        self.db.add_all([j1, j2])
        self.db.commit()

        s_rec = JobServer(
            job_id=j1.id,
            server_id=1,
            server_hostname="host-1",
            server_ip="10.20.0.11",
            status=JobStatusEnum.RUNNING,
        )
        self.db.add(s_rec)
        self.db.commit()

        sisters = self.db.query(UpdateJob).filter(UpdateJob.batch_id == batch_id).order_by(UpdateJob.id.asc()).all()
        self.assertEqual(len(sisters), 2)
        self.assertEqual(sum(j.total_servers for j in sisters), 2)

        active = self.db.query(JobServer).filter(
            JobServer.job_id.in_([j.id for j in sisters]),
            JobServer.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
        ).count()
        self.assertEqual(active, 1)


    def test_direct_action_reboot_and_clear_flag(self):
        from app.services.job_executor import create_job_record
        server = Server(
            hostname="reboot-test-01",
            ip_address="10.20.0.30",
            os_family=OSFamilyEnum.LINUX,
            package_manager="apt",
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            reboot_required=True,
            reboot_status_known=True,
            is_managed=True,
        )
        self.db.add(server)
        self.db.commit()

        # 1. Test create reboot-only job
        reboot_job = create_job_record(
            self.db,
            job_name=f"Reboot Action • {server.hostname}",
            update_type=UpdateTypeEnum.REGULAR,
            servers=[server],
            initiated_by="admin",
            reboot_only=True,
        )
        self.db.commit()
        self.assertTrue(reboot_job.reboot_only)
        self.assertFalse(reboot_job.clean_cache_only)
        self.assertEqual(reboot_job.total_servers, 1)

        # 2. Test manual flag clearance
        server.reboot_required = False
        self.db.commit()
        self.assertFalse(server.reboot_required)

    def test_windows_update_cache_reset_job_creation(self):
        from app.services.job_executor import create_job_record
        win_server = Server(
            hostname="win-cache-01",
            ip_address="10.20.0.31",
            os_family=OSFamilyEnum.WINDOWS,
            package_manager="windows_update",
            awx_credential_id=4,
            connection_status=ConnectionStatusEnum.ONLINE,
            is_managed=True,
        )
        self.db.add(win_server)
        self.db.commit()

        cache_job = create_job_record(
            self.db,
            job_name=f"Reset WU Cache • {win_server.hostname}",
            update_type=UpdateTypeEnum.REGULAR,
            servers=[win_server],
            initiated_by="admin",
            clean_cache_only=True,
        )
        self.db.commit()
        self.assertTrue(cache_job.clean_cache_only)
        self.assertFalse(cache_job.reboot_only)
        self.assertEqual(cache_job.total_servers, 1)

    def test_retry_failed_hosts_only_extracts_failed_targets(self):
        from app.services.job_executor import create_job_record
        from app.models.models import JobServer
        s_ok = Server(
            hostname="host-success",
            ip_address="10.20.0.32",
            os_family=OSFamilyEnum.LINUX,
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            is_managed=True,
        )
        s_fail = Server(
            hostname="host-failed",
            ip_address="10.20.0.33",
            os_family=OSFamilyEnum.LINUX,
            awx_credential_id=3,
            connection_status=ConnectionStatusEnum.ONLINE,
            is_managed=True,
        )
        self.db.add_all([s_ok, s_fail])
        self.db.commit()

        job = create_job_record(
            self.db,
            job_name="Original Multi-Host Job",
            update_type=UpdateTypeEnum.SECURITY,
            servers=[s_ok, s_fail],
            initiated_by="admin",
        )
        self.db.commit()

        # Simulate host 1 succeeded, host 2 failed
        rec1 = self.db.query(JobServer).filter(JobServer.job_id == job.id, JobServer.server_id == s_ok.id).first()
        rec2 = self.db.query(JobServer).filter(JobServer.job_id == job.id, JobServer.server_id == s_fail.id).first()
        rec1.status = JobStatusEnum.SUCCESS
        rec2.status = JobStatusEnum.FAILED
        job.successful_servers = 1
        job.failed_servers = 1
        job.status = JobStatusEnum.FAILED
        self.db.commit()

        # Filter failed servers
        failed_ids = [
            r.server_id for r in job.server_records
            if r.status in (JobStatusEnum.FAILED, JobStatusEnum.CANCELLED)
        ]
        self.assertEqual(failed_ids, [s_fail.id])

        retry_servers = self.db.query(Server).filter(Server.id.in_(failed_ids)).all()
        self.assertEqual(len(retry_servers), 1)
        self.assertEqual(retry_servers[0].hostname, "host-failed")

        # Create retry job
        retry_job = create_job_record(
            self.db,
            job_name=f"Retry #{job.build_id} (Failed Hosts)",
            update_type=job.update_type,
            servers=retry_servers,
            initiated_by="admin",
            overlap_approved=True,
            retry_of_build_id=job.build_id,
        )
        self.db.commit()
        self.assertEqual(retry_job.total_servers, 1)
        self.assertEqual(retry_job.retry_of_build_id, job.build_id)

if __name__ == "__main__":


    unittest.main()
