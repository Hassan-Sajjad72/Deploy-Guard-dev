variable "project_id" {
  type = string
}

variable "environment_name" {
  type = string
}

variable "enable_rule" {
  type    = bool
  default = true
}

variable "ecs_cluster_arn" {
  type    = string
  default = null
}

variable "api_destination_endpoint" {
  type    = string
  default = ""
}

variable "api_destination_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
