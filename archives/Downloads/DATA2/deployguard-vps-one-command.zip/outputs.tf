output "elastic_ip" {
  value = aws_eip.runtime.public_ip
}

output "ssh_command" {
  value = "ssh -i ./deployguard ubuntu@${aws_eip.runtime.public_ip}"
}

output "wildcard_dns" {
  value = "*.${var.apps_domain} -> ${aws_eip.runtime.public_ip}"
}
