# DeployGuard AWS VPS - one-command version

This package is designed so you do NOT manually create or edit terraform.tfvars.

## Prerequisites

You need:
- Terraform
- AWS CLI authenticated to your AWS account
- curl
- ssh-keygen
- a domain you control

Verify AWS:

    aws sts get-caller-identity

## Deploy

Option A — pass the two unavoidable external values directly:

    ./deploy.sh apps.example.com you@example.com

Option B — run without arguments and it asks only for those two:

    ./deploy.sh

The script automatically:
- detects your current public IPv4 for SSH restriction
- generates the SSH key pair
- writes Terraform variables
- initializes Terraform
- validates
- plans
- applies
- creates VPC/subnet/Internet Gateway/route/security group
- creates t3a.medium EC2 (2 vCPU / 4 GiB RAM)
- creates 30 GiB encrypted gp3
- creates/associates Elastic IP
- installs Docker
- initializes one-node Swarm
- creates deployguard-edge network
- deploys Traefik
- prints the Elastic IP, DNS target, and SSH command

## DNS

After apply, create a wildcard A record at your DNS provider:

    *.apps.example.com -> <terraform elastic_ip output>

## Destroy

    ./destroy.sh

## Important

The Runtime Agent artifact itself is not fabricated by this package. The host-side
directory and expected socket configuration are prepared, but the real Runtime
Agent must be installed from your DeployGuard project/release artifact.
