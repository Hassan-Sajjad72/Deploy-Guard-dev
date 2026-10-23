variable "aws_region" {
  description = "AWS region. Pricing quoted in the README assumes us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  type    = string
  default = "deployguard-runtime"
}

variable "instance_type" {
  description = "Single DeployGuard VPS instance type."
  type        = string
  default     = "t3a.medium"
}

variable "root_volume_gib" {
  description = "Encrypted gp3 root disk size."
  type        = number
  default     = 30
}

variable "admin_cidr" {
  description = "Your public IPv4 in CIDR form, e.g. 203.0.113.10/32. Never use 0.0.0.0/0 for SSH."
  type        = string
}

variable "apps_domain" {
  description = "Base application domain, e.g. apps.example.com."
  type        = string
}

variable "acme_email" {
  description = "Email used by Let's Encrypt/ACME."
  type        = string
}

variable "traefik_image" {
  description = "Pinned Traefik release used by the VPS bootstrap."
  type        = string
  default     = "traefik:v3.7.11"
}
