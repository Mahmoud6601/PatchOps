#!/usr/bin/env bash
# Atomic Deployment & Ansible Playbook Sync Script for PatchOps (2-Server Architecture: mgmt + awx)
# Usage:
#   sudo bash /opt/patching-platform/repo/deployment/scripts/deploy.sh          # Deploy latest origin/main
#   sudo bash /opt/patching-platform/repo/deployment/scripts/deploy.sh --rollback # Rollback to previous release

set -euo pipefail

PLATFORM_ROOT="/opt/patching-platform"
REPO_DIR="${PLATFORM_ROOT}/repo"
RELEASES_DIR="${PLATFORM_ROOT}/releases"
CURRENT_LINK="${PLATFORM_ROOT}/current"
VENV_DIR="${PLATFORM_ROOT}/venv"
ENV_FILE="/etc/patching-platform/patching.env"
BARE_PLAYBOOK_GIT="/var/git/patching-playbooks.git"
NODE_CACHE_DIR="${PLATFORM_ROOT}/shared/node_modules_cache"
DEPLOY_USER="${DEPLOY_USER:-$(stat -c '%U' "${REPO_DIR}" 2>/dev/null || echo root)}"
GIT_SSH_KEY="${GIT_SSH_KEY:-/home/${DEPLOY_USER}/.ssh/github_deploy_ed25519}"

if [[ "${1:-}" == "--rollback" ]]; then
    echo ">>> Rolling back to previous release..."
    PREV_RELEASE=$(ls -1dt "${RELEASES_DIR}"/20* 2>/dev/null | sed -n '2p')
    if [[ -z "${PREV_RELEASE}" ]]; then
        echo "ERROR: No previous release found in ${RELEASES_DIR}" >&2
        exit 1
    fi
    ln -sfn "${PREV_RELEASE}" "${CURRENT_LINK}"
    systemctl restart patching-api patching-worker
    systemctl reload nginx
    echo ">>> Rolled back successfully to: ${PREV_RELEASE}"
    exit 0
fi

echo ">>> [1/7] Pulling latest verified commit from Private GitHub (origin/main)..."
if [[ -f "${GIT_SSH_KEY}" ]]; then
    sudo -u "${DEPLOY_USER}" GIT_SSH_COMMAND="ssh -i ${GIT_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
        git -C "${REPO_DIR}" fetch origin main
else
    sudo -u "${DEPLOY_USER}" git -C "${REPO_DIR}" fetch origin main
fi
sudo -u "${DEPLOY_USER}" git -C "${REPO_DIR}" reset --hard origin/main
COMMIT_SHA=$(git -C "${REPO_DIR}" rev-parse --short HEAD)
echo "    Checked out commit: ${COMMIT_SHA}"

echo ">>> [2/7] Syncing backend Python dependencies & running unit tests..."
"${VENV_DIR}/bin/pip" install -q -r "${REPO_DIR}/backend/requirements.txt"
(
    cd "${REPO_DIR}/backend"
    "${VENV_DIR}/bin/python" -m unittest discover -s tests -v
)

echo ">>> [3/7] Staging atomic release directory..."
TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
NEW_RELEASE="${RELEASES_DIR}/${TIMESTAMP}-${COMMIT_SHA}"
install -d -o root -g patching-platform -m 0755 "${NEW_RELEASE}"
cp -a "${REPO_DIR}/backend" "${REPO_DIR}/frontend" "${REPO_DIR}/ansible" "${REPO_DIR}/deployment" "${REPO_DIR}/docs" "${REPO_DIR}/README.md" "${NEW_RELEASE}/"

echo ">>> [4/7] Type-checking & building production React frontend..."
install -d -m 0755 "${PLATFORM_ROOT}/shared"
if [[ ! -d "${NODE_CACHE_DIR}/node_modules" ]]; then
    install -d -m 0755 "${NODE_CACHE_DIR}"
    cp "${NEW_RELEASE}/frontend/package.json" "${NEW_RELEASE}/frontend/package-lock.json" "${NODE_CACHE_DIR}/"
    (cd "${NODE_CACHE_DIR}" && npm ci --no-audit --no-fund)
elif ! cmp -s "${NEW_RELEASE}/frontend/package-lock.json" "${NODE_CACHE_DIR}/package-lock.json"; then
    cp "${NEW_RELEASE}/frontend/package.json" "${NEW_RELEASE}/frontend/package-lock.json" "${NODE_CACHE_DIR}/"
    (cd "${NODE_CACHE_DIR}" && npm ci --no-audit --no-fund)
fi
ln -sfn "${NODE_CACHE_DIR}/node_modules" "${NEW_RELEASE}/frontend/node_modules"
(
    cd "${NEW_RELEASE}/frontend"
    npx tsc --noEmit
    npm run build
)
chmod -R a+rX "${NEW_RELEASE}/frontend/dist"
chown -R root:patching-platform "${NEW_RELEASE}/backend"
chmod -R g+rX "${NEW_RELEASE}/backend"

echo ">>> [5/7] Running idempotent Alembic database migrations..."
systemd-run --wait --pipe \
    --property=User=patching-platform \
    --property=Group=patching-platform \
    --property=WorkingDirectory="${NEW_RELEASE}/backend" \
    --property=EnvironmentFile="${ENV_FILE}" \
    "${VENV_DIR}/bin/alembic" upgrade head

echo ">>> [6/7] Syncing Ansible playbooks to internal Git endpoint & triggering AWX sync..."
if [[ ! -d "${BARE_PLAYBOOK_GIT}/objects" ]]; then
    install -d -o www-data -g www-data -m 0755 "${BARE_PLAYBOOK_GIT}"
    git init --bare --initial-branch=main "${BARE_PLAYBOOK_GIT}"
fi
git config --global --add safe.directory "${BARE_PLAYBOOK_GIT}" || true
git -C "${BARE_PLAYBOOK_GIT}" config http.receivepack false

TMP_ANSIBLE_WORK=$(mktemp -d)
trap 'rm -rf "${TMP_ANSIBLE_WORK}"' EXIT
if git -C "${BARE_PLAYBOOK_GIT}" rev-parse --verify refs/heads/main >/dev/null 2>&1; then
    git clone -q -b main "${BARE_PLAYBOOK_GIT}" "${TMP_ANSIBLE_WORK}/playbooks"
else
    mkdir -p "${TMP_ANSIBLE_WORK}/playbooks"
    git -C "${TMP_ANSIBLE_WORK}/playbooks" init -q -b main
    git -C "${TMP_ANSIBLE_WORK}/playbooks" remote add origin "${BARE_PLAYBOOK_GIT}"
fi
find "${TMP_ANSIBLE_WORK}/playbooks" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -a "${NEW_RELEASE}/ansible/." "${TMP_ANSIBLE_WORK}/playbooks/"
git -C "${TMP_ANSIBLE_WORK}/playbooks" config user.name "PatchOps Deploy"
git -C "${TMP_ANSIBLE_WORK}/playbooks" config user.email "deploy@patchops.local"
git -C "${TMP_ANSIBLE_WORK}/playbooks" add -A
if ! git -C "${TMP_ANSIBLE_WORK}/playbooks" diff --cached --quiet; then
    git -C "${TMP_ANSIBLE_WORK}/playbooks" commit -q -m "chore(ansible): sync playbooks from monorepo commit ${COMMIT_SHA}"
    git -C "${TMP_ANSIBLE_WORK}/playbooks" push -q -u origin main --force
    git -C "${BARE_PLAYBOOK_GIT}" symbolic-ref HEAD refs/heads/main
    git -C "${BARE_PLAYBOOK_GIT}" update-server-info
    chown -R www-data:www-data "${BARE_PLAYBOOK_GIT}"
    echo "    Updated ${BARE_PLAYBOOK_GIT} to commit ${COMMIT_SHA}"
else
    chown -R www-data:www-data "${BARE_PLAYBOOK_GIT}"
    echo "    Ansible playbooks unchanged; skipping bare git commit"
fi

echo ">>> [7/7] Switching current symlink, restarting services & verifying health..."
ln -sfn "${NEW_RELEASE}" "${CURRENT_LINK}"
systemctl restart patching-api patching-worker
systemctl reload nginx

for i in {1..15}; do
    if curl -fsS http://127.0.0.1:8000/api/health/ready >/dev/null 2>&1; then
        echo "    Health check PASSED (/api/health/ready -> 200 OK)"
        break
    fi
    sleep 1
    if [[ "${i}" -eq 15 ]]; then
        echo "ERROR: API failed readiness check after deploy!" >&2
        exit 1
    fi
done

# Trigger AWX Project Sync in background-safe one-liner
systemd-run --wait --pipe \
    --property=User=patching-platform \
    --property=WorkingDirectory="${CURRENT_LINK}/backend" \
    --property=EnvironmentFile="${ENV_FILE}" \
    "${VENV_DIR}/bin/python" -c '
from app.services.awx_client import awx_client
projs = awx_client.call("/projects/?name=OS-Patching-Playbooks").get("results", [])
if projs:
    pid = projs[0]["id"]
    awx_client.call(f"/projects/{pid}/update/", method="POST", data={})
    print(f"    Triggered AWX Project #{pid} sync successfully")
' || echo "    WARN: Could not trigger AWX project sync automatically"

# Keep most recent 5 releases
ls -1dt "${RELEASES_DIR}"/20* 2>/dev/null | tail -n +6 | xargs -r rm -rf

echo ">>> DEPLOYMENT COMPLETE: ${NEW_RELEASE}"
