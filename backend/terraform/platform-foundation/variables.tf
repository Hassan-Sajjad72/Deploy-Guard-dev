variable "aws_region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "At least two public subnets are required for the shared ALB."
  }
}

variable "routing_domain" {
  description = "DNS suffix whose wildcard records resolve to the shared ALB."
  type        = string
}

variable "cluster_name" {
  type    = string
  default = "dg-shared-platform"
}

variable "load_balancer_name" {
  type    = string
  default = "dg-shared-platform"
}

variable "tags" {
  type    = map(string)
  default = {}
}
