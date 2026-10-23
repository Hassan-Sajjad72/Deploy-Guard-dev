output "elastic_ip" {
  value = aws_eip.runtime.public_ip
}

output "instance_id" {
  value = aws_instance.runtime.id
}

output "instance_type" {
  value = aws_instance.runtime.instance_type
}

output "private_ip" {
  value = aws_instance.runtime.private_ip
}

output "ssh_command" {
  value = "ssh -i ./deployguard ubuntu@${aws_eip.runtime.public_ip}"
}

output "dns_record" {
  value = "*.${var.apps_domain} -> ${aws_eip.runtime.public_ip}"
}
