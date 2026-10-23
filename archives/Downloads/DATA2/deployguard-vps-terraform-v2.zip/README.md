# DeployGuard AWS single-VPS Terraform v2

Creates a clean DeployGuard-ready single EC2 runtime from zero.

## What it creates

- VPC: 10.42.0.0/16
- one public subnet
- Internet Gateway
- 0.0.0.0/0 public route
- Security Group:
  - TCP 22 from your admin CIDR only
  - TCP 80 public
  - TCP 443 public
- Ubuntu Server 24.04 LTS amd64
- t3a.medium by default: 2 vCPU / 4 GiB RAM
- 30 GiB encrypted gp3 root EBS
- Elastic IP
- Docker Engine + Compose plugin
- one-node Docker Swarm
- deployguard-edge overlay network
- Traefik
- ACME/Let's Encrypt HTTP-01
- DeployGuard host directories

It does not create NAT Gateway, ALB, ECS, ECR, RDS, or per-app AWS infrastructure.

## Before Terraform

Generate a key locally:

    ssh-keygen -t ed25519 -f deployguard -C "deployguard-runtime"

Copy variables:

    cp terraform.tfvars.example terraform.tfvars

Edit:
- admin_cidr
- apps_domain
- acme_email

## Run

    terraform init
    terraform validate
    terraform plan
    terraform apply

## Outputs

    terraform output

SSH:

    ssh -i ./deployguard ubuntu@$(terraform output -raw elastic_ip)

Verify bootstrap:

    cloud-init status --wait
    sudo tail -n 200 /var/log/deployguard-bootstrap.log
    docker node ls
    docker service ls

## DNS

Point a wildcard A record for the chosen apps_domain at:

    terraform output -raw elastic_ip

Example:

    *.apps.example.com -> <Elastic IP>

## Runtime Agent boundary

The base host is prepared automatically. The actual DeployGuard Runtime Agent
artifact/start command must come from the real DeployGuard application/release;
this Terraform package does not invent it.
