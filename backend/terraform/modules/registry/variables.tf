variable "enabled" {
  type    = bool
  default = false
}

variable "repository_name" {
  type    = string
  default = ""

  validation {
    condition     = !var.enabled || can(regex("^[a-z0-9]+(?:[._/-][a-z0-9]+)*$", var.repository_name))
    error_message = "An enabled ECR repository requires a safe repository name."
  }
}

variable "image_tag_mutability" {
  type    = string
  default = "IMMUTABLE"

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.image_tag_mutability)
    error_message = "image_tag_mutability must be MUTABLE or IMMUTABLE."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
