output "elastic_ip" {
  value       = aws_eip.runtime.public_ip
  description = "Stable public IPv4 address for the DeployGuard VPS."
}

output "ssh_command" {
  value       = "ssh -i ./deployguard ubuntu@${aws_eip.runtime.public_ip}"
  description = "SSH command using the locally generated private key."
}

output "wildcard_dns_record" {
  value       = "*.${var.apps_domain} -> ${aws_eip.runtime.public_ip}"
  description = "Create this wildcard A record at your DNS provider."
}

output "instance_type" {
  value = aws_instance.runtime.instance_type
}

output "runtime_node_private_ip" {
  value = aws_instance.runtime.private_ip
}
