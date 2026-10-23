#!/usr/bin/env bash
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
info()  { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }

command -v terraform >/dev/null 2>&1 || error "Terraform not installed"
command -v aws       >/dev/null 2>&1 || error "AWS CLI not installed"

cd "$(dirname "${BASH_SOURCE[0]}")/../infrastructure"

if [ ! -f terraform.tfvars ]; then
  cp terraform.tfvars.example terraform.tfvars
  warn "Created terraform.tfvars – edit it then re-run."
  exit 1
fi

info "Initializing Terraform..."
terraform init

info "Validating..."
terraform validate

info "Planning..."
terraform plan -out=tfplan

echo ""
read -rp "Apply this plan? (yes/no): " confirm
if [ "$confirm" = "yes" ]; then
  terraform apply tfplan
  info "Done! Outputs:"
  terraform output
else
  warn "Cancelled."
fi
