#!/usr/bin/env bash
# ==============================================================================
# PatchOps — Infrastructure Security & TLS Hardening Script
# Supports:
#   sudo bash harden-infra.sh --role mgmt [--mgmt-ip 10.20.0.10] [--awx-ip 10.20.0.20]
#   sudo bash harden-infra.sh --role awx  [--mgmt-ip 10.20.0.10] [--awx-ip 10.20.0.20]
# ==============================================================================
set -Eeuo pipefail

ROLE=""
MGMT_IP="10.20.0.10"
AWX_IP="10.20.0.20"
RENEW_CERT="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    --mgmt-ip)
      MGMT_IP="${2:-}"
      shift 2
      ;;
    --awx-ip)
      AWX_IP="${2:-}"
      shift 2
      ;;
    --renew-cert)
      RENEW_CERT="true"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: Run this script with sudo / as root." >&2
  exit 1
fi

if [[ "${ROLE}" != "mgmt" && "${ROLE}" != "awx" ]]; then
  echo "Usage: sudo bash $0 --role <mgmt|awx> [--mgmt-ip IP] [--awx-ip IP] [--renew-cert]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

harden_mgmt() {
  echo "==> [mgmt] 1/4 Provisioning PatchOps Internal Root CA & Server TLS Certificate..."
  local pki_dir="/etc/patching-platform/pki"
  local ca_key="${pki_dir}/patchops-root-ca.key"
  local ca_crt="${pki_dir}/patchops-root-ca.crt"
  local srv_key="/etc/ssl/private/patching-platform.key"
  local srv_crt="/etc/ssl/certs/patching-platform.crt"

  install -d -m 0750 -o root -g patching-platform "${pki_dir}"

  if [[ ! -f "${ca_key}" || ! -f "${ca_crt}" ]]; then
    local ca_cnf
    ca_cnf="$(mktemp)"
    cat > "${ca_cnf}" <<'EOF'
[req]
default_bits       = 4096
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_ca

[dn]
O  = PatchOps Enterprise Platform
OU = Infrastructure Security PKI
CN = PatchOps Internal Root CA

[v3_ca]
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints       = critical, CA:true, pathlen:0
keyUsage               = critical, digitalSignature, cRLSign, keyCertSign
EOF
    openssl genrsa -out "${ca_key}" 4096
    chmod 0600 "${ca_key}"
    chown root:root "${ca_key}"

    openssl req -x509 -new -nodes -key "${ca_key}" -sha256 -days 3650 \
      -out "${ca_crt}" -config "${ca_cnf}"
    rm -f "${ca_cnf}"
  fi

  chmod 0644 "${ca_crt}"
  chown root:patching-platform "${ca_crt}"
  cp -f "${ca_crt}" /usr/local/share/ca-certificates/patchops-root-ca.crt
  update-ca-certificates >/dev/null

  if [[ ! -f "${srv_key}" || ! -f "${srv_crt}" || "${RENEW_CERT}" == "true" ]]; then
    local srv_csr srv_ext
    srv_csr="$(mktemp)"
    srv_ext="$(mktemp)"
    cat > "${srv_ext}" <<EOF
authorityKeyIdentifier = keyid,issuer
basicConstraints       = CA:FALSE
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectAltName         = IP:${MGMT_IP},IP:127.0.0.1,DNS:mgmt-srv,DNS:patchops.local,DNS:localhost
EOF
    openssl genrsa -out "${srv_key}" 2048
    chmod 0600 "${srv_key}"
    chown root:root "${srv_key}"

    openssl req -new -key "${srv_key}" \
      -subj "/O=PatchOps Enterprise Platform/CN=${MGMT_IP}" \
      -out "${srv_csr}"

    openssl x509 -req -in "${srv_csr}" \
      -CA "${ca_crt}" -CAkey "${ca_key}" -CAcreateserial \
      -out "${srv_crt}" -days 825 -sha256 -extfile "${srv_ext}"

    chmod 0644 "${srv_crt}"
    chown root:root "${srv_crt}"
    rm -f "${srv_csr}" "${srv_ext}" "${pki_dir}/patchops-root-ca.srl"
  fi

  echo "==> [mgmt] 2/4 Installing Nginx Security Headers Snippet & TLS Site Configuration..."
  install -d -m 0755 /etc/nginx/snippets
  cat > /etc/nginx/snippets/patchops-security-headers.conf <<'EOF'
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
EOF

  sed "s/__AWX_SERVER_IP__/${AWX_IP}/g" \
    "${REPO_DIR}/deployment/nginx/patching-platform.conf.example" \
    > /etc/nginx/sites-available/patching-platform

  ln -sfn /etc/nginx/sites-available/patching-platform /etc/nginx/sites-enabled/patching-platform
  rm -f /etc/nginx/sites-enabled/default

  echo "==> [mgmt] 3/4 Validating & Reloading Nginx..."
  nginx -t
  systemctl reload nginx

  echo "==> [mgmt] 4/4 Configuring UFW Host Firewall..."
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment 'OpenSSH Admin Access'
  ufw allow 80/tcp comment 'HTTP->HTTPS Redirect & Internal AWX Git Sync'
  ufw allow 443/tcp comment 'PatchOps HTTPS UI & REST API'
  ufw --force enable
  ufw status verbose
}

harden_awx() {
  echo "==> [awx] 1/2 Installing PatchOps Internal Root CA if staged..."
  if [[ -f /usr/local/share/ca-certificates/patchops-root-ca.crt ]]; then
    chmod 0644 /usr/local/share/ca-certificates/patchops-root-ca.crt
    update-ca-certificates >/dev/null
  fi

  echo "==> [awx] 2/2 Configuring UFW Host Firewall (K3s + Flannel + AWX Safe Rules)..."
  ufw default deny incoming
  ufw default allow outgoing
  ufw default allow routed

  ufw allow in on lo comment 'Loopback'
  ufw allow in on cni0 comment 'K3s CNI Pod Bridge'
  ufw allow in on flannel.1 comment 'K3s Flannel VXLAN'
  ufw allow from 10.42.0.0/16 comment 'K3s Pod CIDR'
  ufw allow from 10.43.0.0/16 comment 'K3s Service CIDR'
  ufw allow from "${AWX_IP}" comment 'K3s Local Node Hairpin'

  ufw allow 22/tcp comment 'OpenSSH Admin Access'
  ufw allow 80/tcp comment 'AWX Traefik HTTP'
  ufw allow 443/tcp comment 'AWX Traefik HTTPS'
  ufw allow from "${MGMT_IP}" to any port 30080 proto tcp comment 'AWX NodePort HTTP from mgmt'
  ufw allow from "${MGMT_IP}" to any port 30112 proto tcp comment 'AWX NodePort HTTPS from mgmt'

  ufw --force enable
  ufw status verbose
}

if [[ "${ROLE}" == "mgmt" ]]; then
  harden_mgmt
else
  harden_awx
fi

echo "==> Hardening completed successfully for role: ${ROLE}"
