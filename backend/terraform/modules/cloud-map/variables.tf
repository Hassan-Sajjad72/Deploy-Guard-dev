variable "project_id" {
  type = string
}

variable "environment_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "namespace_name" {
  type = string
}

variable "default_service_name" {
  type    = string
  default = "app"
}

variable "tags" {
  type = map(string)
}
