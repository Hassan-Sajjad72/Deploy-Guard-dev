variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "deployguard-runtime"
}

variable "instance_type" {
  type    = string
  default = "t3a.medium"
}

variable "root_volume_gib" {
  type    = number
  default = 30
}

variable "admin_cidr" {
  type = string
}

variable "apps_domain" {
  type = string
}

variable "acme_email" {
  type = string
}

variable "traefik_image" {
  type    = string
  default = "traefik:v3.7.10"
}
