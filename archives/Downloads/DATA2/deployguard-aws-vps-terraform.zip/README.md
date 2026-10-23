# DeployGuard single-VPS AWS Terraform

This Terraform creates exactly one generic Linux RuntimeNode on AWS:

- dedicated VPC
- one public subnet
- Internet Gateway + public route
- security group: SSH from admin CIDR, HTTP/HTTPS public
- Ubuntu 24.04 LTS amd64
- t3a.medium by default (2 vCPU / 4 GiB RAM)
- 30 GiB encrypted gp3 root EBS
- one Elastic IP
- Docker Engine + Compose plugin
- single-node Docker Swarm
- deployguard-edge overlay network
- Traefik on 80/443 with HTTP->HTTPS and Let's Encrypt HTTP-01
- local DeployGuard backup/runtime/monitoring directories

It does NOT create NAT Gateway, ALB, ECS, ECR, RDS, or per-application AWS infrastructure.

## 1. Generate SSH key

From this directory:

    ssh-keygen -t ed25519 -f deployguard -C "deployguard-runtime"

This creates:
- deployguard        (private key; keep local)
- deployguard.pub    (Terraform uploads only this public key)

## 2. Configure variables

    cp terraform.tfvars.example terraform.tfvars

Set:
- admin_cidr: your own public IPv4 /32
- apps_domain: e.g. apps.yourdomain.com
- acme_email

## 3. Deploy

    terraform init
    terraform fmt -check
    terraform validate
    terraform plan
    terraform apply

## 4. Get IP / SSH

    terraform output
    ssh -i ./deployguard ubuntu@$(terraform output -raw elastic_ip)

## 5. DNS

At your DNS provider create:

    Type: A
    Name: *.apps       (exact UI varies by provider)
    Value: <terraform output elastic_ip>

The exact record name depends on the parent domain you own.

## 6. Verify bootstrap

On the server:

    cloud-init status --wait
    sudo tail -n 200 /var/log/deployguard-bootstrap.log
    docker node ls
    docker service ls
    docker network inspect deployguard-edge

Expected Traefik Swarm service:

    deployguard-edge_traefik

## Runtime Agent

The host and base runtime are fully bootstrapped. The Runtime Agent binary/source
must come from the actual DeployGuard repository/release. This package does not
invent a download URL or entry point that is not present in the supplied backend
subset.
