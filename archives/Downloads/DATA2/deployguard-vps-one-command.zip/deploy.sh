#!/usr/bin/env bash
set -Eeuo pipefail

APP_DOMAIN="${1:-}"
ACME_EMAIL="${2:-}"

if [ -z "$APP_DOMAIN" ]; then
  read -rp "Apps domain (example: apps.example.com): " APP_DOMAIN
fi

if [ -z "$ACME_EMAIL" ]; then
  read -rp "Let's Encrypt email: " ACME_EMAIL
fi

if [ -z "$APP_DOMAIN" ] || [ -z "$ACME_EMAIL" ]; then
  echo "Domain and email are required."
  exit 1
fi

for cmd in terraform ssh-keygen curl aws; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd"
    exit 1
  }
done

# Fail early if AWS credentials are not usable.
aws sts get-caller-identity >/dev/null

PUBLIC_IP="$(curl -4fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
if [ -z "$PUBLIC_IP" ]; then
  echo "Could not determine your public IPv4."
  exit 1
fi

if [ ! -f ./deployguard ] || [ ! -f ./deployguard.pub ]; then
  ssh-keygen -t ed25519 -N "" -f ./deployguard -C "deployguard-runtime"
fi

cat > terraform.auto.tfvars <<EOF
aws_region      = "us-east-1"
admin_cidr      = "${PUBLIC_IP}/32"
apps_domain     = "${APP_DOMAIN}"
acme_email      = "${ACME_EMAIL}"
instance_type   = "t3a.medium"
root_volume_gib = 30
EOF

chmod 600 ./deployguard
chmod 644 ./deployguard.pub

terraform init
terraform validate
terraform plan -out=tfplan

echo
echo "Creating DeployGuard VPS with:"
echo "  Region:       us-east-1"
echo "  Instance:     t3a.medium (2 vCPU / 4 GiB RAM)"
echo "  Root disk:    30 GiB encrypted gp3"
echo "  SSH source:   ${PUBLIC_IP}/32"
echo "  Apps domain:  ${APP_DOMAIN}"
echo

terraform apply -auto-approve tfplan

echo
terraform output

echo
echo "After DNS is pointed to the Elastic IP, connect with:"
terraform output -raw ssh_command
echo
