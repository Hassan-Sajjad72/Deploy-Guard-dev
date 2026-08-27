locals {
  log_group_arn      = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/deployguard/*"
  log_stream_arn     = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/deployguard/*:log-stream:*"
  security_group_arn = "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*"
  managed_secret_arn = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:deployguard/*"
  efs_arns = [
    "arn:aws:elasticfilesystem:${var.aws_region}:${var.aws_account_id}:file-system/*",
    "arn:aws:elasticfilesystem:${var.aws_region}:${var.aws_account_id}:access-point/*",
  ]
}

data "aws_iam_policy_document" "deployguard_logs" {
  # CloudWatch Logs does not support resource-level scoping for this read API.
  # Terraform's aws_cloudwatch_log_group refresh requires it.
  statement {
    sid       = "ReadLogGroupInventoryForTerraform"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid = "ManageDeployGuardLogGroups"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
    ]
    resources = [local.log_group_arn]
  }

  statement {
    sid = "WriteDeployGuardLogStreams"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = [local.log_group_arn, local.log_stream_arn]
  }

  # Elastic Load Balancing does not support resource-level authorization or
  # service condition keys for DescribeTargetHealth. The rollback verifier
  # supplies the exact, ownership-verified target-group ARN at runtime.
  statement {
    sid       = "ReadTargetHealthForRollbackVerification"
    actions   = ["elasticloadbalancing:DescribeTargetHealth"]
    resources = ["*"]
  }

  # ECS ListTasks does not support resource-level permissions. Restrict the
  # required wildcard to DeployGuard-named clusters in this account and region.
  statement {
    sid       = "ListTasksForDestroyVerification"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnLike"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/dg-*"]
    }
  }

  # EC2 authorizes tags supplied with CreateSecurityGroup through a separate
  # CreateTags check. Limit that check to tagged DeployGuard creation only.
  statement {
    sid       = "TagDeployGuardSecurityGroupsAtCreation"
    actions   = ["ec2:CreateTags"]
    resources = [local.security_group_arn]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSecurityGroup"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["DeployGuard"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["dev", "production"]
    }

    condition {
      test     = "Null"
      variable = "aws:RequestTag/DeployGuardProjectId"
      values   = ["false"]
    }
  }

  # Secret identity does not exist until CreateSecret succeeds. Require the
  # ownership tags that every generated DeployGuard secret supplies.
  statement {
    sid       = "CreateTaggedDeployGuardSecrets"
    actions   = ["secretsmanager:CreateSecret"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["DeployGuard"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["dev", "production"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/DeployGuardProjectId"
      values   = ["false"]
    }
  }

  statement {
    sid = "ReadDeployGuardSecretMetadataForAdoption"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListSecretVersionIds",
    ]
    resources = [local.managed_secret_arn]
  }

  statement {
    sid = "ReconcileTaggedDeployGuardSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:UpdateSecretVersionStage",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:DeleteSecret",
      "secretsmanager:RestoreSecret",
    ]
    resources = [local.managed_secret_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/ManagedBy"
      values   = ["DeployGuard"]
    }
  }

  # These inventory calls do not support resource-level authorization and are
  # required by Terraform refresh and deterministic adoption.
  statement {
    sid = "DescribeDeployGuardDatabaseStorage"
    actions = [
      "elasticfilesystem:DescribeAccessPoints",
      "elasticfilesystem:DescribeFileSystems",
      "elasticfilesystem:DescribeLifecycleConfiguration",
      "elasticfilesystem:DescribeMountTargets",
      "elasticfilesystem:DescribeMountTargetSecurityGroups",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "CreateTaggedDeployGuardDatabaseStorage"
    actions   = ["elasticfilesystem:CreateFileSystem"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["DeployGuard"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/DeployGuardProjectId"
      values   = ["false"]
    }
  }

  statement {
    sid = "ReconcileTaggedDeployGuardDatabaseStorage"
    actions = [
      "elasticfilesystem:CreateAccessPoint",
      "elasticfilesystem:CreateMountTarget",
      "elasticfilesystem:DeleteAccessPoint",
      "elasticfilesystem:DeleteFileSystem",
      "elasticfilesystem:DeleteMountTarget",
      "elasticfilesystem:PutLifecycleConfiguration",
      "elasticfilesystem:TagResource",
      "elasticfilesystem:UntagResource",
      "elasticfilesystem:UpdateFileSystem",
    ]
    resources = local.efs_arns

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/ManagedBy"
      values   = ["DeployGuard"]
    }
  }
}

resource "aws_iam_policy" "deployguard_logs" {
  name        = "DeployGuardGitHubActionsLogs"
  description = "Project-agnostic access limited to DeployGuard-owned CloudWatch log groups."
  policy      = data.aws_iam_policy_document.deployguard_logs.json
}

resource "aws_iam_role_policy_attachment" "deployguard_logs" {
  role       = var.github_actions_role_name
  policy_arn = aws_iam_policy.deployguard_logs.arn
}
