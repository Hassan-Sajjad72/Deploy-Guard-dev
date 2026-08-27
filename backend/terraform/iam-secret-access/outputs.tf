output "execution_role_name" {
  value = var.execution_role_name
}

output "secret_reference_fingerprint_input" {
  value     = sort(var.secret_arns)
  sensitive = true
}
