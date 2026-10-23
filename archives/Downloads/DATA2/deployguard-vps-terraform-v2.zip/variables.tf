variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "deployguard-runtime"
}

variable "instance_type" {
  description = "Default: 2 vCPU / 4 GiB RAM."
  type        = string
  default     = "t3a.medium"
}

variable "root_volume_gib" {
  type    = number
  default = 30
}

variable "admin_cidr" {
  description = "Your own public IPv4 as /32, e.g. 203.0.113.10/32."
  type        = string

  validation {
    condition     = can(cidrhost(var.admin_cidr, 0)) && !contains(["0.0.0.0/0"], var.admin_cidr)
    error_message = "admin_cidr must be a restricted CIDR, not 0.0.0.0/0."
  }
}

variable "ssh_public_key_path" {
  description = "Local public key path. Private key never enters Terraform state."
  type        = string
  default     = "./deployguard.pub"
}

variable "apps_domain" {
  description = "Base app domain, e.g. apps.example.com."
  type        = string
}

variable "acme_email" {
  description = "Let's Encrypt/ACME email."
  type        = string
}

variable "traefik_image" {
  description = "Pinned Traefik release."
  type        = string
  default     = "traefik:v3.7.10"
}
