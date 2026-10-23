import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GetPolicyCommand, GetPolicyVersionCommand, IAMClient } from "@aws-sdk/client-iam";
import { DataSource } from "typeorm";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { customerMutationAuthorized } from "../workspaces/customer-authority-proof";
import { customerControlPlanePrincipal } from "../workspaces/customer-control-plane-principal";
import { HostingProfileRegistryService } from "./hosting-profile-registry.service";
import { Project, ProjectStatus } from "../projects/project.entity";
import { planFingerprint } from "./deployment-plan";

export type HostingProviderScope = { organizationId: string; projectId: string; bindingId: string; bindingVersion: number; accountId: string; operationId: string; generationId: string; region: string; environment: string; profile: "ec2" | "lightsail" | "static" | "lambda"; stateBucket: string; dnsZoneId?: string; dnsRecordName?: string };
export type HostingProviderSession = { accountId: string; region: string; expiresAt: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string } };

export function hostingProviderSessionPolicy(scope: HostingProviderScope) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (![scope.projectId, scope.organizationId, scope.bindingId, scope.operationId, scope.generationId].every((v) => uuid.test(v)) || !/^\d{12}$/.test(scope.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(scope.region) || !["production", "staging", "sandbox", "development"].includes(scope.environment) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(scope.stateBucket) || !Number.isInteger(scope.bindingVersion) || scope.bindingVersion < 1 || !["ec2", "lightsail", "static", "lambda"].includes(scope.profile)) throw new ConflictException("Invalid provider session scope.");
  const project = `dg-${scope.projectId.replaceAll("-", "").slice(0, 12)}`;
  const name = `${project}-${scope.generationId.replaceAll("-", "").slice(0, 12)}`;
  const bucket = `${name}-${scope.accountId}`;
  const state = `organizations/${scope.organizationId}/projects/${scope.projectId}/${scope.environment}/profiles/${scope.profile}/generations/${scope.generationId}/terraform.tfstate`;
  const arn = `arn:aws`;
  const regional = { StringEquals: { "aws:RequestedRegion": scope.region } };
  const statements: any[] = [
    { Effect: "Allow", Action: ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource: `${arn}:iam::${scope.accountId}:policy/deployguard/${scope.organizationId}/${scope.projectId}/${scope.profile}/${scope.region}` },
    { Effect: "Allow", Action: ["s3:GetBucketLocation", "s3:ListBucket"], Resource: [`${arn}:s3:::${scope.stateBucket}`, `${arn}:s3:::${bucket}`] },
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`${arn}:s3:::${scope.stateBucket}/${state}`, `${arn}:s3:::${scope.stateBucket}/${state}.tflock`] },
  ];
  if (["ec2", "lightsail"].includes(scope.profile)) {
    if (!/^Z[A-Z0-9]{4,32}$/.test(scope.dnsZoneId || "") || !new RegExp(`^g-${scope.generationId.replaceAll('-', '').slice(0, 12)}\\.(?:[a-z0-9-]+\\.)+[a-z]{2,63}$`).test(scope.dnsRecordName || "")) throw new ConflictException("Generation DNS scope is required for VM execution.");
    statements.push({ Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets"], Resource: `arn:aws:route53:::hostedzone/${scope.dnsZoneId}` },
      { Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: `arn:aws:route53:::hostedzone/${scope.dnsZoneId}`, Condition: { "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": scope.dnsRecordName, "route53:ChangeResourceRecordSetsRecordTypes": "A" } } },
      { Effect: "Allow", Action: ["route53:GetChange"], Resource: "arn:aws:route53:::change/*" });
  }
  // A second permission intersection is mandatory. The operator-approved customer role policy
  // supplies individual actions; this session fence restricts resource families to this generation.
  // APIs with no resource-level authorization still require region and executor ownership checks.
  if (scope.profile === "ec2") statements.push(
    { Effect: "Allow", Action: ["ec2:Describe*"], Resource: "*", Condition: regional },
    { Effect: "Allow", Action: ["ec2:RunInstances", "ec2:CreateSecurityGroup", "ec2:AllocateAddress", "ec2:CreateTags"], Resource: "*", Condition: { ...regional, StringEqualsIfExists: { "aws:RequestTag/ProjectId": scope.projectId, "aws:RequestTag/GenerationId": scope.generationId } } },
    { Effect: "Allow", Action: ["ec2:TerminateInstances", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:ReleaseAddress"], Resource: `arn:aws:ec2:${scope.region}:${scope.accountId}:*/*`, Condition: { ...regional, StringEquals: { "aws:ResourceTag/ProjectId": scope.projectId, "aws:ResourceTag/GenerationId": scope.generationId } } },
  );
  if (scope.profile === "lightsail") statements.push({ Effect: "Allow", Action: ["lightsail:GetInstance", "lightsail:GetInstances", "lightsail:GetStaticIp", "lightsail:GetInstancePortStates", "lightsail:GetBlueprints", "lightsail:GetBundles", "lightsail:GetRegions"], Resource: "*", Condition: regional },
    { Effect: "Allow", Action: ["lightsail:CreateInstances", "lightsail:TagResource", "lightsail:AllocateStaticIp", "lightsail:AttachStaticIp", "lightsail:DetachStaticIp", "lightsail:ReleaseStaticIp", "lightsail:PutInstancePublicPorts", "lightsail:DeleteInstance"], Resource: `arn:aws:lightsail:${scope.region}:${scope.accountId}:*`, Condition: { ...regional, StringEqualsIfExists: { "aws:RequestTag/ProjectId": scope.projectId, "aws:ResourceTag/ProjectId": scope.projectId } } });
  if (["ec2", "lambda"].includes(scope.profile)) statements.push({ Effect: "Allow", Action: ["iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:PassRole", "iam:CreateInstanceProfile", "iam:GetInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile"], Resource: [`arn:aws:iam::${scope.accountId}:role/${name}`, `arn:aws:iam::${scope.accountId}:instance-profile/${name}`] },
    { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:ListTagsForResource"], Resource: [`arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/${scope.organizationId}/${scope.projectId}/${scope.environment}/${scope.generationId}:*`, `arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/aws/lambda/${name}:*`, `arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/http/${name}:*`] });
  if (["static", "lambda"].includes(scope.profile)) statements.push({ Effect: "Allow", Action: ["s3:CreateBucket", "s3:DeleteBucket", "s3:GetBucket*", "s3:PutBucket*", "s3:ListBucketVersions", "s3:GetObjectVersion", "s3:DeleteObjectVersion", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectAttributes"], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/generations/${scope.generationId}/*`] });
  if (scope.profile === "lambda") statements.push({ Effect: "Allow", Action: ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:DeleteFunction", "lambda:PublishVersion", "lambda:CreateAlias", "lambda:GetAlias", "lambda:DeleteAlias", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:ListTags", "lambda:TagResource", "lambda:PutFunctionConcurrency", "lambda:GetFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], Resource: [`arn:aws:lambda:${scope.region}:${scope.accountId}:function:${name}`, `arn:aws:lambda:${scope.region}:${scope.accountId}:function:${name}:*`] },
    { Effect: "Allow", Action: ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"], Resource: `arn:aws:apigateway:${scope.region}::/apis*`, Condition: { StringEqualsIfExists: { "aws:ResourceTag/ProjectId": scope.projectId, "aws:RequestTag/ProjectId": scope.projectId } } });
  if (scope.profile === "static") statements.push({ Effect: "Allow", Action: ["cloudfront:CreateDistribution", "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:DeleteOriginAccessControl"], Resource: "*", Condition: { StringEqualsIfExists: { "aws:RequestTag/ProjectId": scope.projectId, "aws:ResourceTag/ProjectId": scope.projectId } } });
  return { Version: "2012-10-17", Statement: statements };
}

@Injectable()
export class HostingProviderSessionService {
  constructor(private readonly data: DataSource, private readonly config: ConfigService, private readonly profiles: HostingProfileRegistryService) {}
  async withSession<T>(scope: HostingProviderScope, callback: (context: HostingProviderSession) => Promise<T>): Promise<T> {
    const policy = hostingProviderSessionPolicy(scope);
    const project = await this.data.getRepository(Project).findOneBy({ id: scope.projectId, organizationId: scope.organizationId });
    if (!project || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId || project.awsAccountBindingId !== scope.bindingId) throw new NotFoundException("Active provider project and account scope not found.");
    const binding = await this.data.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId").where("binding.id=:id AND binding.organizationId=:organizationId", { id: scope.bindingId, organizationId: scope.organizationId }).getOne();
    if (!binding || binding.verificationStatus !== "verified" || binding.verificationVersion !== scope.bindingVersion || binding.accountId !== scope.accountId || !binding.regions.includes(scope.region) || !customerMutationAuthorized(this.config, binding, project.id) || !this.profiles.available(scope.profile, scope.region)) throw new ConflictException("Current customer mutation and final provider authorization are required.");
    const controlPrincipal = customerControlPlanePrincipal(this.config);
    if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(controlPrincipal)) throw new ServiceUnavailableException("A verified control-plane principal is required.");
    const [{ archived_at: archivedAt } = {}] = await this.data.query(`SELECT archived_at FROM organizations WHERE id=$1`, [scope.organizationId]);
    if (archivedAt !== null) throw new ConflictException("An active customer workspace is required.");
    // AWS inline session policies are bounded at 2048 characters. Never drop permissions fences
    // to fit that limit: larger profiles need a verified managed intersection policy.
    const encoded = JSON.stringify(policy);
    const policyArn = this.config.get<string>(`HOSTING_${scope.profile.toUpperCase()}_SESSION_POLICY_ARN`, "");
    if (encoded.length > 2048 && !new RegExp(`^arn:aws:iam::${scope.accountId}:policy/deployguard/${scope.organizationId}/${scope.projectId}/${scope.profile}/${scope.region}$`).test(policyArn)) throw new ServiceUnavailableException("A verified project-specific provider session policy must be installed before execution.");
    const sts = new STSClient({ region: scope.region, maxAttempts: 1 }); let identity: STSClient | null = null; let iam: IAMClient | null = null;
    try {
      const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: binding.roleArn, ExternalId: binding.externalId, RoleSessionName: `dg-${scope.operationId}`, DurationSeconds: 900,
        ...(encoded.length <= 2048 ? { Policy: encoded } : { PolicyArns: [{ arn: policyArn }] }) }), { abortSignal: AbortSignal.timeout(15000) });
      const creds = assumed.Credentials;
      if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration || creds.Expiration.getTime() <= Date.now() + 60000) throw new Error("Invalid temporary session");
      const context = { accountId: scope.accountId, region: scope.region, expiresAt: creds.Expiration.toISOString(), credentials: { accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken } };
      identity = new STSClient({ region: scope.region, credentials: context.credentials, maxAttempts: 1 });
      const proof = await identity.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
      if (proof.Account !== scope.accountId || !proof.Arn?.startsWith(`arn:aws:sts::${scope.accountId}:assumed-role/${binding.roleArn.split('/').at(-1)}/`)) throw new Error("Account identity changed");
      if (encoded.length > 2048) {
        iam = new IAMClient({ region: scope.region, credentials: context.credentials, maxAttempts: 1 });
        const policyMetadata = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }), { abortSignal: AbortSignal.timeout(10000) });
        if (!policyMetadata.Policy?.DefaultVersionId) throw new ConflictException("Provider intersection policy verification is unavailable.");
        const policyVersion = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: policyMetadata.Policy.DefaultVersionId }), { abortSignal: AbortSignal.timeout(10000) });
        const document = policyVersion.PolicyVersion?.Document;
        if (!document || planFingerprint(JSON.parse(decodeURIComponent(document))) !== planFingerprint(policy)) throw new ConflictException("The provider intersection policy differs from this exact generation and approved resource scope.");
      }
      const current = await this.data.getRepository(AwsAccountBinding).findOneBy({ id: scope.bindingId, organizationId: scope.organizationId });
      if (!current || current.verificationStatus !== "verified" || current.verificationVersion !== scope.bindingVersion || !customerMutationAuthorized(this.config, current, project.id)) throw new ConflictException("Customer account authorization changed before provider execution.");
      return await callback(context);
    } finally { sts.destroy(); identity?.destroy(); iam?.destroy(); }
  }
}
