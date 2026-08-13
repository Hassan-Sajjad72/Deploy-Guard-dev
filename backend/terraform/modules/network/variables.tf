variable "project_id" {
  type = string
}

variable "project_name" {
  type = string
}

variable "environment_name" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_cidrs" {
  type = list(string)
}

variable "private_subnet_cidrs" {
  type = list(string)
}

variable "nat_mode" {
  type = string
}

variable "availability_zone_names" {
  type    = list(string)
  default = []
}

variable "enable_https" {
  type = bool
}

variable "app_port" {
  type = number
}

variable "tags" {
  type = map(string)
}
