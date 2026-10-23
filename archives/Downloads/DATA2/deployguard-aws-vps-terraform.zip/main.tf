terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

# Latest official Canonical Ubuntu 24.04 LTS amd64 gp3 AMI.
data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/noble/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_vpc" "deployguard" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name}-vpc"
  }
}

resource "aws_internet_gateway" "deployguard" {
  vpc_id = aws_vpc.deployguard.id

  tags = {
    Name = "${var.name}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.deployguard.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-public-subnet"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.deployguard.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.deployguard.id
  }

  tags = {
    Name = "${var.name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "runtime" {
  name        = "${var.name}-sg"
  description = "DeployGuard single-node runtime"
  vpc_id      = aws_vpc.deployguard.id

  ingress {
    description = "SSH from administrator only"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTP for Traefik and ACME"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS for applications"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Runtime outbound access"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name}-sg"
  }
}

# Create deployguard.pub locally; the private key never enters Terraform state.
resource "aws_key_pair" "deployguard" {
  key_name   = "${var.name}-key"
  public_key = file("${path.module}/deployguard.pub")

  tags = {
    Name = "${var.name}-key"
  }
}

resource "aws_instance" "runtime" {
  ami                         = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.runtime.id]
  key_name                    = aws_key_pair.deployguard.key_name
  associate_public_ip_address = false

  monitoring = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gib
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  # Keep T3/T3a costs predictable during sustained testing.
  credit_specification {
    cpu_credits = "standard"
  }

  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    acme_email   = var.acme_email
    apps_domain  = var.apps_domain
    traefik_image = var.traefik_image
  })

  tags = {
    Name                    = var.name
    "deployguard.role"      = "runtime-node"
    "deployguard.topology"  = "single-node"
  }

  depends_on = [
    aws_route_table_association.public
  ]
}

resource "aws_eip" "runtime" {
  domain = "vpc"

  tags = {
    Name = "${var.name}-eip"
  }

  depends_on = [aws_internet_gateway.deployguard]
}

resource "aws_eip_association" "runtime" {
  instance_id   = aws_instance.runtime.id
  allocation_id = aws_eip.runtime.id
}
