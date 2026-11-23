# Infrastructure Assessment and Deployment Notes

Assessment date: 2026-11-12. The three existing VMs were reachable over SSH. This document records the initial state and the local code changes; it does not indicate that the new code has been deployed.

## Existing topology observed

| VM role | Address | Observed services |
| --- | --- | --- |
| AWX | `10.20.0.20` | Ubuntu 24.04, K3s, AWX 24.6.1, HTTPS NodePort 30112, HTTP NodePort 30080 |
| Management | `10.20.0.10` | Ubuntu 24.04, FastAPI on port 8000, Nginx on port 80, PostgreSQL 16 bound to localhost, Redis |
| Repository | `10.20.0.30` | Ubuntu 24.04, internal Git HTTP, Ansible Core 2.16.3, `ansible.windows` 2.2.0, `community.general` 8.3.0 |

All three VMs reported 8 vCPUs, 15 GiB RAM, and roughly 163–171 GB free on the root filesystem. SSH, cross-host reachability, NTP, and the existing AWX pods were healthy during the initial inspection. UFW was inactive. Nginx served the dashboard over plain HTTP. No firewall, host, Kubernetes, database, AWX, or systemd settings were changed during that initial assessment.

## Existing implementation risks found

- The deployed API source fell back to a fixed JWT signing key and a fixed PostgreSQL credential. The process environment did not contain the expected AWX token/configuration variables.
- The old source seeded predictable administrator/operator accounts and demo inventory values, and the login UI included a preset credential.
- An AWX launch failure or missing job ID could still be recorded as successful; stage results were not tied reliably to AWX events. The old implementation also fetched a limited event page and did not persist execution logs.
- Schedules were stored but had no persistent dispatcher. Major-upgrade jobs could report success without upgrading the operating system.
- The Debian security workflow could update all packages, and the Windows security selection included non-security critical updates.
- The WebSocket route was unauthenticated, CORS allowed any origin with credentials, and the frontend stored its token in local storage.
- Nginx used plain HTTP. UFW was inactive, so network filtering was not provided by the host firewall.
- The provided project brief included a plaintext VM password. It is not reproduced here; rotate that credential before production use.

The updated source removes insecure defaults and demo seeding, requires explicit application secrets, disables API docs by default, uses in-memory bearer-token storage, records AWX events and logs, and refuses ambiguous success. It also adds migrations and a separate worker. The reviewed release was deployed to the management VM on 2026-11-13: the legacy API unit is stopped and disabled, the new API and worker are enabled, and Nginx serves the new frontend and proxies the API on the existing internal HTTP endpoint. The API listens only on loopback. A protected PostgreSQL backup was taken before migration; legacy inventory rows remain retired pending administrator review, and schedules remain paused.

The migration is deliberately fail-closed for legacy operational state: existing inventory rows are retained but marked retired/offline with old discovery counts cleared; existing schedules are paused; queued legacy jobs are cancelled; and running legacy jobs without an AWX ID are failed with an instruction to inspect AWX. After deployment, an administrator must review retired hosts, restore only approved targets, run discovery, and review paused schedules before re-enabling them. Running legacy jobs with a stored AWX ID remain pollable.

## Changes prepared locally

- `backend/app`: secure configuration, authentication, CRUD and reporting routes, AWX integration, persistent job/event handling, a durable scheduler worker, and administration CLI.
- `backend/migrations`: an Alembic revision that adds the new fields/tables and `DISCOVERY` update type while preserving existing history.
- `frontend/src`: authenticated session handling, real inventory and job actions, role-aware controls, schedule editing, and truthful status displays.
- `ansible/`: security-scoped Linux and Windows update tasks, discovery, reboot checks, verification, safe defaults, and a sample inventory without credentials.
- `deployment/systemd/`: separate API and worker service templates. These use the dedicated `patching-platform` system account and are installed and active on the management VM.

Manual overlapping jobs are blocked by default. An administrator can mark one launch as an explicit overlap approval; the API records that choice in the job and audit log. Canceled AWX stages and per-host mixed results are represented separately from successful and failed work.

## Configuration required before deployment

1. Create a dedicated Linux service account/group named `patching-platform`; ensure the application tree is readable by it and the environment file is not.
2. Provision a database and least-privilege PostgreSQL account. Configure `DATABASE_URL` without putting the password into command history or a committed file.
3. Generate a unique JWT key (at least 32 characters) and store the populated environment file at `/etc/patching-platform/patching.env` with root ownership and mode `0640`. Do not copy secrets into Git.
4. Set `AWX_URL` to an HTTPS DNS name covered by AWX's certificate. Keep certificate verification enabled. Create a narrowly scoped AWX token and configure `AWX_INVENTORY_ID`.
5. In AWX, verify that all four named templates exist, use the exact configured inventory, and point at the intended project and execution environment. Keep the Linux SSH credential attached to each template and enable credential selection at launch. Create Windows Machine credentials in the platform's AWX organization, then choose one for each Windows server in Server Management. The worker synchronizes each target into the selected inventory before launch, including WinRM HTTPS port, transport, and certificate validation variables; it never writes passwords into inventory variables. Mixed Linux/Windows jobs are rejected and must be scheduled separately.
6. Adapt `deployment/nginx/patching-platform.conf.example` for the management DNS name and certificate, then proxy `/api/` to `127.0.0.1:8000`. Do not expose the backend port or AWX NodePorts publicly. Decide and apply firewall rules through the organization's approved change process.
7. Back up PostgreSQL, run `alembic upgrade head`, create a new administrator with the interactive CLI, then reset or disable any legacy seeded accounts. The migration preserves account rows; it does not silently deactivate users or change passwords. It does pause legacy schedules and inventory pending administrator review.
8. Install the systemd unit templates, then start the API and worker. The worker holds a PostgreSQL advisory lock so only one scheduler instance dispatches jobs.

Example commands after staging code and secrets (review paths and service ownership for the target host first):

```bash
sudo install -d -o root -g patching-platform -m 0750 /etc/patching-platform
sudo install -o root -g patching-platform -m 0640 backend/.env.example /etc/patching-platform/patching.env
sudo systemd-run --wait --pipe \
  --property=User=patching-platform \
  --property=WorkingDirectory=/opt/patching-platform/current/backend \
  --property=EnvironmentFile=/etc/patching-platform/patching.env \
  /opt/patching-platform/current/backend/venv/bin/alembic upgrade head
sudo systemd-run --wait --pty \
  --property=User=patching-platform \
  --property=WorkingDirectory=/opt/patching-platform/current/backend \
  --property=EnvironmentFile=/etc/patching-platform/patching.env \
  /opt/patching-platform/current/backend/venv/bin/python -m app.cli create-admin <username>
```

The `install` example creates only the directory and copies a template. Fill the destination with real values through the approved secret-handling process before running migrations or starting services. The service account must have read access to the application tree and database access; it must not own the secret file.

### Staging and service installation commands

Run these on a reviewed deployment copy during the approved maintenance window. Replace source paths, DNS, database name, and certificate paths. These commands are documentation only; they were not run on the VMs.

```bash
# Create the dedicated service identity once.
sudo groupadd --system patching-platform
sudo useradd --system --gid patching-platform --home-dir /var/lib/patching-platform \
  --create-home --shell /usr/sbin/nologin patching-platform

# Provision the database using local PostgreSQL peer authentication.
sudo -u postgres createuser --pwprompt patching_app
sudo -u postgres createdb --owner=patching_app patching_platform

# Install each reviewed release separately and point `current` at the active one.
RELEASE_DIR=/opt/patching-platform/releases/2026-11-12-01
sudo install -d -o root -g patching-platform -m 0750 "$RELEASE_DIR"
sudo cp -a backend frontend "$RELEASE_DIR/"
sudo install -d -o patching-platform -g patching-platform -m 0750 "$RELEASE_DIR/backend/venv"
sudo -u patching-platform python3 -m venv "$RELEASE_DIR/backend/venv"
sudo -u patching-platform "$RELEASE_DIR/backend/venv/bin/pip" install \
  --requirement "$RELEASE_DIR/backend/requirements.txt"

# Build on the reviewed build workstation using the lockfile, then install the artifact.
npm ci --prefix frontend
npm run build --prefix frontend
sudo cp -a frontend/dist "$RELEASE_DIR/frontend/"
sudo chmod -R a+rX "$RELEASE_DIR/frontend/dist"
sudo ln -sfn "$RELEASE_DIR" /opt/patching-platform/current

# Back up before applying the database migration.
sudo install -d -o postgres -g postgres -m 0700 /var/backups/patching-platform
sudo -u postgres pg_dump --format=custom --dbname=patching_platform \
  --file=/var/backups/patching-platform/pre-migration.dump
```

Populate the protected environment file before migrating. Copy the systemd unit files to `/etc/systemd/system/`, adapt the Nginx example to the approved DNS/certificate, and validate Nginx before reloading it:

```bash
sudo install -o root -g root -m 0644 deployment/systemd/patching-api.service \
  /etc/systemd/system/patching-api.service
sudo install -o root -g root -m 0644 deployment/systemd/patching-worker.service \
  /etc/systemd/system/patching-worker.service
sudo install -o root -g root -m 0644 deployment/nginx/patching-platform.conf.example \
  /etc/nginx/sites-available/patching-platform.conf
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl daemon-reload
```

After reviewing paused schedules and legacy users, run the Alembic migration and create an administrator through the environment-aware one-shot commands above. Only then should the new API and worker be enabled and health-checked:

```bash
sudo systemctl enable --now patching-api patching-worker
curl --fail https://patching.example.internal/api/health/live
curl --fail https://patching.example.internal/api/health/ready
```

Before starting either service, confirm the API unit is bound to `127.0.0.1:8000`, the Nginx certificate matches the configured DNS name, and AWX templates use the configured inventory. Do not start the worker until AWX credentials, templates, test targets, and paused schedule state have been reviewed.

## Verification plan and limits

Static and unit checks can be performed on this source without running a playbook. A real integration test needs dedicated Linux and Windows test hosts in a test AWX inventory:

1. Confirm certificate-verified AWX API access, template discovery, inventory synchronization, and test credentials.
2. Run discovery only against test hosts; compare reported OS, update counts, and reboot state with each host.
3. Exercise an unreachable test host and a deliberately failing test task; confirm the job and per-host rows fail honestly and retain AWX logs/events.
4. Run a security-only patch on a disposable test host; inspect the actual package/KB changes, controlled reboot, post-update verification, and the historical export.
5. Test schedules in a test timezone, including daylight-saving transitions, overlap prevention, and worker restart recovery.
6. Confirm cancellation and worker recovery behavior. If the AWX launch response is ambiguous, inspect AWX before retrying; the system does not auto-launch the same job again.
7. Verify API health, RBAC, TLS, backup/restore, and operator runbooks before production approval.

No dedicated test-machine credentials were supplied. The production deployment and database migration completed on 2026-11-13, and the worker reconciled the pre-existing AWX job record against AWX. A Windows discovery attempt failed before connecting because the target name was absent from AWX inventory; no task events were recorded and no host was changed. The release synchronizes selected targets before dispatch and supports a launch-time Windows Machine credential selected per server in Server Management, while retaining the template SSH credential for Linux. Windows execution remains blocked until WinRM, the execution environment, template credential prompting, and a Windows credential selection are configured. The dashboard remains on the existing internal HTTP endpoint; firewall and TLS settings were not changed. Major OS upgrades intentionally stop after preflight: there is no tested distro-specific executor in this project yet.
