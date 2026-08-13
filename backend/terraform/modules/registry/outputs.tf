output "repository_name" {
  value = var.enabled ? aws_ecr_repository.this[0].name : null
}

output "repository_url" {
  value = var.enabled ? aws_ecr_repository.this[0].repository_url : null
}

output "image_tag_mutability" {
  value = var.enabled ? aws_ecr_repository.this[0].image_tag_mutability : null
}
