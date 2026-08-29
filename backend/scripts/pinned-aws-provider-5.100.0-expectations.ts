/**
 * Independent provider-source expectations for indirect refresh/destroy calls
 * used by infrastructure/railpack-runtime. These are intentionally separate
 * from the application capability manifest: changing both manifests cannot
 * hide an omitted provider helper call.
 *
 * Source: hashicorp/terraform-provider-aws v5.100.0, commit
 * f7a3b98da589ab1d52756b0dcee0dbf2de83d635.
 */
export const PINNED_AWS_PROVIDER_VERSION = "5.100.0";
export const PINNED_AWS_PROVIDER_REVISION = "f7a3b98da589ab1d52756b0dcee0dbf2de83d635";

export const PINNED_PROVIDER_INDIRECT_API_EXPECTATIONS = [
  {
    terraformResource: "aws_security_group",
    lifecycle: "destroy",
    providerFunction: "resourceSecurityGroupDelete -> deleteLingeringENIs -> findNetworkInterfaces",
    providerFile: "internal/service/ec2/vpc_security_group.go:357",
    action: "ec2:DescribeNetworkInterfaces",
  },
  {
    terraformResource: "aws_lb_listener",
    lifecycle: "read",
    providerFunction: "resourceListenerRead -> findListenerAttributesByARN",
    providerFile: "internal/service/elbv2/listener.go:817",
    action: "elasticloadbalancing:DescribeListenerAttributes",
  },
  {
    terraformResource: "aws_efs_file_system",
    lifecycle: "read",
    providerFunction: "resourceFileSystemRead",
    providerFile: "internal/service/efs/file_system.go:301",
    action: "elasticfilesystem:DescribeLifecycleConfiguration",
  },
  {
    terraformResource: "aws_secretsmanager_secret",
    lifecycle: "read",
    providerFunction: "resourceSecretRead -> findSecretPolicyByID",
    providerFile: "internal/service/secretsmanager/secret.go:251",
    action: "secretsmanager:GetResourcePolicy",
  },
] as const;
