# PatchOps — Enterprise OS Patching & Endpoint Management Platform

**PatchOps** is a production-grade OS Patching and Endpoint Management Platform built with **FastAPI**, **React (TypeScript + Tailwind CSS)**, **PostgreSQL**, and **Ansible AWX**.

## 1. What PatchOps Does

PatchOps orchestrates the complete 5-stage patching lifecycle across multi-tenant **Linux (Debian/Ubuntu, RHEL/Rocky/AlmaLinux, SUSE)** and **Windows** fleets from a single dashboard:

- **Discovery (`Stage 1`):** Collects OS release, kernel version, architecture, CPU/RAM resources, pending update counts, security update counts, and pending reboot flags.
- **Pre-check (`Stage 2`) & Security / Regular Patching (`Stage 3`):** Applies security-classified updates (`patch_security.yml`) or regular updates (`patch_regular.yml`), with automated Windows Update self-healing (`DISM`, `SFC`, `SoftwareDistribution` cache reset).
- **Major OS Upgrade (`Stage 2–5`):** Gated distribution release upgrades (`do-release-upgrade` / `leapp`) requiring dual administrator and backup verification flags.
- **Controlled Reboot (`Stage 4`) & Verification (`Stage 5`):** Detects reboot requirements, executes safe reboots with reachability checks, and re-verifies remaining pending updates.
- **Compliance Reporting & Audit Trail:** Exports per-run CSV reports, tracks installed patch history per host, streams live telemetry over SSE, enforces customer/OS-scoped RBAC, and maintains an immutable audit log.
- **Zero Target Passwords in App DB:** PatchOps never stores SSH passwords, SSH keys, or WinRM passwords in PostgreSQL. Target hosts are referenced by numeric **AWX Credential ID** only; AWX injects encrypted credentials at execution time.

---

## 2. Production 2-Server Architecture

PatchOps uses a streamlined **2-Server Architecture** (`mgmt-srv` + `awx-srv`), removing the need for a separate Git server:

| Server / Tier | Repository Paths | Components & Responsibilities |
|---|---|---|
| **1. Management & Playbook Host (`mgmt-srv`)** | `backend/`, `frontend/`, `ansible/`, `deployment/nginx/`, `deployment/systemd/`, `deployment/scripts/` | FastAPI REST API (`uvicorn` on `127.0.0.1:8000`), PostgreSQL 16 (app DB & advisory-locked worker queue), React SPA Dashboard, Nginx TLS Reverse Proxy, and an IP-restricted `/git/patching-playbooks.git` HTTP endpoint serving `ansible/` directly to AWX |
| **2. Automation Engine (`awx-srv`)** | `deployment/awx-server/`, `execution-environment/` | K3s Kubernetes cluster running AWX Operator (`v24.6.1`), Dynamic Inventory (`Enterprise-Managed-Servers`), Custom Execution Environment, and the 4 Job Templates (`Discovery`, `Security`, `Regular`, `Major Upgrade`) |

---

## 3. Prerequisites

- **Operating System:** Ubuntu Server 24.04 LTS (recommended) on both `mgmt-srv` and `awx-srv`.
- **Management Host (`mgmt-srv`):**
  - Python `3.12+` with `venv`
  - Node.js `20+` and `npm`
  - PostgreSQL `16` (`postgresql`)
  - Nginx (`nginx`) + `fcgiwrap` + `git` (`git-http-backend` for serving `/var/git/patching-playbooks.git`)
  - Read-only SSH Deploy Key (`~/.ssh/github_deploy_ed25519`) registered on your Git repository so `deploy.sh` can pull `origin/main` cleanly.
- **AWX Host (`awx-srv`):**
  - K3s Kubernetes cluster with **AWX Operator `v24.6.1`** (`deployment/awx-server/k8s/awx-instance.yaml`).
  - **Custom Execution Environment (EE):** Built from `execution-environment/execution-environment.yml` (`quay.io/ansible/awx-ee:24.6.1` + `ansible.windows`, `ansible.posix`, `community.general >= 8.3.0`). Standard `awx-ee:24.6.1` does not include `community.general`; `ansible/collections/requirements.yml` also remains in the repo as a Galaxy sync fallback (~3 min) if you run without the custom EE (~2s sync). See [`execution-environment/README.md`](execution-environment/README.md).

---

## 4. Deployment Steps (`deploy.sh`)

1. **Provision `patching-platform` service account, PostgreSQL DB, and systemd units** on `mgmt-srv`:
   - Install `deployment/systemd/patching-api.service` and `deployment/systemd/patching-worker.service` into `/etc/systemd/system/` and run `sudo systemctl daemon-reload`.
2. **Clone the repository** on `mgmt-srv` into `/opt/patching-platform/repo` and create the Python virtual environment at `/opt/patching-platform/venv`:
   ```bash
   sudo mkdir -p /opt/patching-platform/releases /opt/patching-platform/shared
   git clone <your-repo-url> /opt/patching-platform/repo
   python3 -m venv /opt/patching-platform/venv
   ```
3. **Configure environment secrets & TLS/firewall hardening:**
   - Copy `backend/.env.example` to `/etc/patching-platform/patching.env` (`chmod 0640`, owner `root:patching-platform`) and populate all values (see Section 5).
   - Run the hardening script once per host with your real LAN IPs:
     ```bash
     sudo bash /opt/patching-platform/repo/deployment/scripts/harden-infra.sh --role mgmt --mgmt-ip <MGMT_IP> --awx-ip <AWX_IP>
     sudo bash /opt/patching-platform/repo/deployment/scripts/harden-infra.sh --role awx  --mgmt-ip <MGMT_IP> --awx-ip <AWX_IP>
     ```
4. **Run atomic production deployment (`deploy.sh`):**
   ```bash
   sudo bash /opt/patching-platform/repo/deployment/scripts/deploy.sh
   ```
   `deploy.sh` performs 7 atomic steps: pulls `origin/main` (using `DEPLOY_USER` or the owner of `/opt/patching-platform/repo`), runs the backend unit test suite, stages a timestamped release directory, runs `npx tsc --noEmit` and `npm run build`, applies `alembic upgrade head`, pushes `ansible/` to `/var/git/patching-playbooks.git`, switches `/opt/patching-platform/current`, restarts `patching-api` and `patching-worker`, verifies `/api/health/ready` returns `200 OK`, and triggers an AWX Project Sync.
5. **Create the initial Admin user** (first deploy only):
   ```bash
   sudo systemd-run --wait --pty \
     --property=User=patching-platform \
     --property=WorkingDirectory=/opt/patching-platform/current/backend \
     --property=EnvironmentFile=/etc/patching-platform/patching.env \
     /opt/patching-platform/venv/bin/python -m app.cli create-admin admin
   ```
6. **Instant 1-second Rollback:**
   ```bash
   sudo bash /opt/patching-platform/repo/deployment/scripts/deploy.sh --rollback
   ```
7. **CI Gate (`.github/workflows/ci.yml`):** Every push and PR to `main` runs two automated jobs before deployment:
   - **Backend Unit Tests (Python 3.12):** `pip install -r backend/requirements.txt` and `python -m unittest discover -s tests -v`.
   - **Frontend TypeScript & Vite Build (Node 20):** `npm ci`, `npx tsc --noEmit`, and `npm run build`.

---

## 5. Configuration Map (Where to Put Your Own Data)

**Server IPs and credentials are NEVER written in any repository file.** Populate only runtime configuration files on your hosts and UI resources in PatchOps / AWX:

### A. Server IPs and Hostnames (Never in Git)
- **PatchOps Dashboard UI:** Sign in as Admin and navigate to **Endpoint Inventory** (`/servers`) → **Customer Organizations → Add Customer** (optional tenant grouping + default credential inheritance), then click **Add Server** to enter each target's hostname, IP address, OS family (`linux` / `windows`), and AWX Credential.
- **AWX Inventory UI:** In AWX, ensure the dynamic inventory named `Enterprise-Managed-Servers` exists under **Resources → Inventories → `Enterprise-Managed-Servers` → Hosts** (the PatchOps worker automatically syncs managed servers from PostgreSQL into this AWX inventory ID before each run).

### B. Secrets, Database & AWX Settings (`/etc/patching-platform/patching.env`)
Copy [`backend/.env.example`](backend/.env.example) to `/etc/patching-platform/patching.env` on `mgmt-srv` and populate each variable:

| Variable | Description | Where Its Value Comes From |
|---|---|---|
| `SECRET_KEY` | JWT signing key (min 32 chars) | Generated locally (e.g. `openssl rand -urlsafe 48`) |
| `DATABASE_URL` | PostgreSQL SQLAlchemy DSN | `postgresql://<db_user>:<db_pass>@localhost:5432/<db_name>` |
| `PROJECT_NAME` | Platform display title | Keep default or set organization title |
| `API_V1_STR` | FastAPI router prefix | Keep `/api` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Short-lived JWT TTL (minutes) | Operational security policy (e.g. `60`, code default `15`) |
| `ENABLE_API_DOCS` | Expose Swagger/OpenAPI endpoints | Keep `false` in production |
| `CORS_ORIGINS` | Allowed browser origins JSON list | `[]` when served same-origin via Nginx, or `["https://<host>"]` |
| `AWX_URL` | Base HTTPS URL of AWX API | Your `awx-srv` HTTPS URL (e.g. `https://<AWX_HOST>`) |
| `AWX_TOKEN` | Scoped AWX Personal Access Token | AWX UI → **Users → `<service-account>` → Tokens → Add** |
| `AWX_VERIFY_SSL` | Verify AWX TLS certificate (`true`/`false`) | `true` with trusted/internal CA (`AWX_CA_BUNDLE`) |
| `AWX_CA_BUNDLE` | Path to internal CA bundle PEM | `/etc/patching-platform/awx-ca.pem` (if using internal PKI) |
| `AWX_INVENTORY_ID` | Numeric ID of AWX target inventory | URL ID of `Enterprise-Managed-Servers` in AWX UI |
| `AWX_DISCOVERY_TEMPLATE_NAME` | Discovery Job Template name | `Template-OS-Discovery` |
| `AWX_SECURITY_TEMPLATE_NAME` | Security Patching Template name | `Template-Security-Patching` |
| `AWX_REGULAR_TEMPLATE_NAME` | Regular Patching Template name | `Template-Regular-Patching` |
| `AWX_MAJOR_UPGRADE_TEMPLATE_NAME` | Major OS Upgrade Template name | `Template-Major-OS-Upgrade` |
| `AWX_WINDOWS_WINRM_TRANSPORT` | WinRM auth method (`ntlm`/`kerberos`) | `ntlm` (workgroup/AD) or `kerberos` (domain-joined) |
| `AWX_WINDOWS_WINRM_SERVER_CERT_VALIDATION` | WinRM HTTPS cert check (`validate`/`ignore`) | `validate` for trusted certs; `ignore` for self-signed WinRM |
| `AWX_POLL_INTERVAL_SECONDS` | Worker poll interval for AWX jobs | `5` seconds |
| `AWX_JOB_TIMEOUT_SECONDS` | Hard timeout for AWX jobs | `86400` seconds (24h) |
| `DISCOVERY_MAX_AGE_HOURS` | Max staleness before re-discovery | `24` hours |
| `WORKER_POLL_INTERVAL_SECONDS` | Worker loop interval for queued jobs/schedules | `5` seconds |

### C. AWX Credentials
Create **Machine** credentials in AWX (**Resources → Credentials → Add**) for Linux (SSH private key or user/password + sudo) and Windows (WinRM user/password). PatchOps queries credential metadata via `/api/servers/awx-machine-credentials` and stores only the integer `awx_credential_id` per server or Customer Group.

### D. AWX Project & Job Templates
Configure AWX according to [`deployment/awx-server/awx-templates-spec.json`](deployment/awx-server/awx-templates-spec.json):
- **Project (`OS-Patching-Playbooks`):** SCM Type `Git`, URL `http://<MGMT_IP>/git/patching-playbooks.git`, Branch `main`, Update Revision on Launch enabled.
- **Job Templates** (enable `Prompt on launch` for Credential, Limit, Variables; select the Custom EE `PatchOps Custom EE 24.6.1`):
  - `Template-OS-Discovery` → `playbooks/discovery.yml`
  - `Template-Security-Patching` → `playbooks/patch_security.yml`
  - `Template-Regular-Patching` → `playbooks/patch_regular.yml`
  - `Template-Major-OS-Upgrade` → `playbooks/upgrade_major_os.yml`

### E. Local Inventory Example (`ansible/inventory/hosts.yml.example`)
For local Ansible CLI syntax/dry-run tests only, copy `ansible/inventory/hosts.yml.example` to `ansible/inventory/hosts.yml` (which is gitignored) and enter temporary lab IPs. Do not store passwords inside inventory files.

---

## 6. First Run After Deploy

1. Sign in to the PatchOps Dashboard (`https://<MGMT_IP>`) and verify the top-bar badge displays **AWX Online**.
2. Add **one** test Linux or Windows server in **Endpoint Inventory** (`/servers`) with its assigned AWX Credential.
3. Run **Discovery** on that single server and open the Job Detail page (`/runs/<RUN_ID>`): confirm all stage telemetry completes cleanly and pending/security update counts populate in the inventory table.
4. Run **Security Patching** on that same server and verify Stage 1 (Discovery), Stage 2 (Pre-check), Stage 3 (Update), Stage 4 (Reboot), and Stage 5 (Verification) execute and record package logs accurately.
5. **Do NOT run Major OS Upgrade first** — Major OS Upgrade (`upgrade_major_os.yml`) is gated by `confirm_major_upgrade` + `backup_verified` and intended only for planned distribution version upgrades after verified snapshots.

---

## 7. Supported Operating Systems Matrix

| OS Family | Distributions / Versions | Package Manager / Tooling | Current Verification Status |
|---|---|---|---|
| **Debian / Ubuntu** | Ubuntu LTS, Debian | `apt` + `apt_update_inventory.py` + `do-release-upgrade` | Live end-to-end verified on managed Linux endpoints (`Discovery`, `Security`, `Regular`, `Reboot`, `Verification`) |
| **RedHat Family** | RHEL, Rocky Linux, AlmaLinux | `dnf` + `needs-restarting` + `leapp` | Playbooks, stage telemetry, and backend parsing implemented; requires RHEL lab target for live integration verification |
| **SUSE** | SLES / openSUSE | `community.general.zypper` (isolated in `suse.yml` / `suse_verify.yml`) + `needs-restarting` | Playbooks isolated via dynamic `include_tasks` and backed by custom EE + fallback `requirements.yml`; requires SUSE lab target for live verification |
| **Windows** | Windows Server 2016/2019/2022/2025, Windows 10/11 | `ansible.windows.win_updates` over WinRM HTTPS + `DISM`/`SFC` self-healing | Playbooks, WinRM inventory sync, and stage/KB telemetry implemented and unit-tested; requires WinRM-configured Windows host for live verification |

---

## 8. Troubleshooting First-Run Failures

1. **AWX Template Name Mismatch**
   - **Symptom:** Job immediately fails in PatchOps with `AWX job template 'Template-...' was not found` or `404` on launch.
   - **Fix:** Ensure all four Job Template names in AWX UI match `/etc/patching-platform/patching.env` and `backend/app/config.py` exactly (`Template-OS-Discovery`, `Template-Security-Patching`, `Template-Regular-Patching`, `Template-Major-OS-Upgrade`), then restart `patching-worker`.
2. **Execution Environment Missing `community.general`**
   - **Symptom:** AWX fails with `ERROR! couldn't resolve module/action 'community.general.zypper'`.
   - **Fix:** Either assign the custom EE built from [`execution-environment/execution-environment.yml`](execution-environment/execution-environment.yml) to your Job Templates, or trigger an AWX **Project Sync** on `OS-Patching-Playbooks` so `ansible/collections/requirements.yml` installs `community.general >= 8.3.0` from Galaxy.
3. **AWX Token or SSL Certificate Validation Failure**
   - **Symptom:** Dashboard header shows **AWX Offline**, or `/api/servers/awx-machine-credentials` returns `502 Bad Gateway` / `CERTIFICATE_VERIFY_FAILED` / `401 Unauthorized`.
   - **Fix:** Verify `AWX_URL` uses `https://` matching the AWX endpoint certificate, set `AWX_CA_BUNDLE=/etc/patching-platform/awx-ca.pem` (or `AWX_VERIFY_SSL=false` only on trusted isolated lab networks), confirm `AWX_TOKEN` is active and valid in AWX UI, and restart `patching-api` and `patching-worker`.

---

## 9. Repository Structure & Security Notice

```text
├── .github/workflows/ci.yml        # Automated CI gate (45+ backend tests + TypeScript/Vite build)
├── execution-environment/          # Custom AWX EE definition (ansible-builder) + setup guide
├── ansible/                        # Ansible playbooks, isolated OS roles, and collection requirements
│   ├── collections/                # requirements.ee.yml (Custom EE) & requirements.yml (Galaxy fallback)
│   ├── inventory/                  # Sanitized example inventory (hosts.yml.example)
│   ├── playbooks/                  # Entrypoint playbooks mapped to AWX Job Templates
│   └── roles/                      # discovery, linux_patching, windows_patching, major_upgrade
├── backend/                        # FastAPI API, SQLAlchemy ORM, Worker, Alembic migrations & tests
├── frontend/                       # React 18 + TypeScript + Vite + Tailwind CSS SPA
├── deployment/                     # K3s AWX specs, hardened Nginx templates, systemd units, deploy/harden scripts
├── docs/                           # Infrastructure assessment & deployment notes
└── LICENSE                         # MIT License
```

**Security Notice:** Never commit populated `.env` / `patching.env` files, database dumps, TLS private keys (`*.key`, `*.pem`), kubeconfigs, AWX API tokens, or real host inventories.

## License

This project is licensed under the **MIT License** — see [`LICENSE`](LICENSE) for details.
