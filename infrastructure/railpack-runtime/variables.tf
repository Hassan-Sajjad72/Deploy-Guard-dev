variable "region" { type = string }
variable "project_id" { type = string }
variable "operation_id" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "services" {
  type = map(object({
    name                       = string
    image                      = string
    runtime_config_revision_id = string
    service_port               = number
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
  validation {
    condition     = alltrue([for service in values(var.services) : service.service_port >= 1 && service.service_port <= 65535 && floor(service.service_port) == service.service_port])
    error_message = "Every service port must be an integer from 1 to 65535."
  }
  validation {
    condition = alltrue([for service in values(var.services) : !service.database_attached || service.managed_database_engine != "mysql" || (
      length(service.managed_database_aliases) == 17 &&
      toset(service.managed_database_aliases) == toset(["DB_HOST", "DATABASE_HOST", "MYSQL_HOST", "DB_PORT", "DATABASE_PORT", "MYSQL_PORT", "DB_USER", "DATABASE_USER", "MYSQL_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD", "DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE", "DATABASE_URL", "MYSQL_URL"])
    )])
    error_message = "An attached managed MySQL service requires the complete DeployGuard-owned runtime alias set."
  }
}
