resource "aws_iam_role_policy" "runtime_secret_access" {
  name = "deployguard-runtime-secret-access"
  role = var.execution_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadExactRuntimeSecrets"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = sort(var.secret_arns)
    }]
  })
}
