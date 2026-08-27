variable "aws_region" {
  type = string
}

variable "aws_account_id" {
  type = string

  validation {
    condition     = can(regex("^\\d{12}$", var.aws_account_id))
    error_message = "aws_account_id must be exactly 12 digits."
  }
}

variable "offline_plan_mode" {
  type    = bool
  default = false
}

variable "execution_role_name" {
  type = string

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.execution_role_name))
    error_message = "execution_role_name is invalid."
  }
}

variable "secret_arns" {
  type = list(string)

  validation {
    condition = length(var.secret_arns) == 3 && length(distinct(var.secret_arns)) == 3 && alltrue([
      for arn in var.secret_arns :
      can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\\d{12}:secret:[A-Za-z0-9/_+=.@-]+$", arn))
    ])
    error_message = "secret_arns must contain exactly three distinct Secrets Manager ARNs."
  }
}
