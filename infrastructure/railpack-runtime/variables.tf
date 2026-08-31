variable "region" { type = string }
variable "project_id" { type = string }
variable "operation_id" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "platform_port" { type = number }
variable "services" {
  type = map(object({
    name                       = string
    image                      = string
    runtime_config_revision_id = string
    environment                = map(string)
    secret_references          = map(string)
    database_attached          = bool
    managed_database_aliases   = list(string)
    managed_database_engine    = string
  }))
  validation {
    condition     = length(var.services) > 0
    error_message = "At least one deployable service is required."
  }
  validation {
    condition     = alltrue([for service in values(var.services) : can(regex("^[0-9a-fA-F-]{36}$", service.runtime_config_revision_id))])
    error_message = "Every service requires an immutable runtime configuration revision UUID."
  }
}
