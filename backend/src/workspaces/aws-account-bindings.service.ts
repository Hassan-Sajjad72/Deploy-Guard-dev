import { customerControlPlanePrincipal } from "./customer-control-plane-principal";
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GetRoleCommand, IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { DataSource } from "typeorm";
import { randomBytes } from "crypto";
import { User } from "../users/user.entity";
import { AuditLogService } from "../audit-log/audit-log.service";
import { WorkspacesService } from "./workspaces.service";
import { AwsAccountBinding } from "./aws-account-binding.entity";
import { CreateAwsAccountBindingDto } from "./aws-account-binding.dto";

export function validateCustomerRoleTrust(policy: unknown, principal: string, externalId: string) {
  const statements = (policy as { Statement?: unknown })?.Statement;
  const allows = (Array.isArray(statements) ? statements : statements ? [statements] : []).filter((statement: any) => statement.Effect === "Allow");
  const platformAccount = principal.split(":")[4];
  let controlTrusted = false;
  if (!allows.length || !allows.every((statement: any) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const principals = Array.isArray(statement.Principal?.AWS) ? statement.Principal.AWS : [statement.Principal?.AWS];
    if (principals.includes(principal)) controlTrusted = true;
    return actions.every((action: unknown) => action === "sts:AssumeRole" || action === "sts:TagSession")
      && actions.includes("sts:AssumeRole") && principals.length > 0 && principals.every((role: unknown) => typeof role === "string" && (role === principal || new RegExp(`^arn:aws:iam::${platformAccount}:role/(?:dg-customer-broker-[0-9a-f]{12}|deployguard/customer-brokers/[0-9a-f-]{36}/[A-Za-z0-9+=,.@_-]+)$`).test(role)))
      && Object.keys(statement.Principal).length === 1
      && statement.Condition?.StringEquals?.["sts:ExternalId"] === externalId;
  }) || !controlTrusted) throw new BadRequestException("Customer role trust must restrict AssumeRole to the configured control-plane principal and explicit isolated customer brokers, with this binding's external ID.");
}

@Injectable()
export class AwsAccountBindingsService {
  constructor(private readonly database: DataSource, private readonly config: ConfigService, private readonly workspaces: WorkspacesService, private readonly audit: AuditLogService) {}

  async list(user: User, organizationId: string) {
    await this.workspaces.assertMembership(user, organizationId);
    return this.database.getRepository(AwsAccountBinding).find({ where: { organizationId }, order: { createdAt: "DESC" } });
  }

  async create(user: User, organizationId: string, dto: CreateAwsAccountBindingDto) {
    await this.workspaces.assertMembership(user, organizationId, true);
    if (dto.roleArn.split(":")[4] !== dto.accountId) throw new BadRequestException("Role and account identity must match.");
    const allowed = this.config.get<string>("DEPLOYGUARD_ALLOWED_AWS_REGIONS", this.config.get<string>("AWS_REGION", "us-east-1")).split(",").map((region) => region.trim());
    if (dto.regions.some((region) => !allowed.includes(region))) throw new BadRequestException("A requested region is not enabled for AWS onboarding.");
    const externalId = randomBytes(32).toString("hex");
    const trustPolicy = this.trustPolicy(externalId);
    const repository = this.database.getRepository(AwsAccountBinding);
    let binding: AwsAccountBinding;
    try { binding = await repository.save(repository.create({ organizationId, ...dto, externalId, verificationStatus: "pending" })); }
    catch (error) { if ((error as { code?: string }).code === "23505") throw new ConflictException("This AWS role is already bound to the workspace."); throw error; }
    await this.audit.record({ actorUser: user, action: "AWS_BINDING_CREATED", resourceType: "aws_binding", resourceId: binding.id, status: "success", metadata: { organizationId } });
    const { externalId: _hidden, ...publicBinding } = binding;
    return { binding: publicBinding, trustPolicy };
  }

  async onboardingPolicy(user: User, organizationId: string, id: string) {
    await this.workspaces.assertMembership(user, organizationId, true);
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId")
      .where("binding.id = :id AND binding.organizationId = :organizationId", { id, organizationId }).getOne();
    if (!binding) throw new NotFoundException("AWS binding not found.");
    return this.trustPolicy(binding.externalId);
  }

  private trustPolicy(externalId: string) {
    const principal = customerControlPlanePrincipal(this.config);
    if (!/^arn:aws:iam::\d{12}:role\/.+$/.test(principal)) throw new ServiceUnavailableException("The control-plane AWS role is not configured.");
    return { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principal }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": externalId } } }] };
  }

  async verify(user: User, organizationId: string, id: string) {
    await this.workspaces.assertMembership(user, organizationId, true);
    const [[started]] = await this.database.query(`UPDATE aws_account_bindings SET verification_status = 'pending', verified_at = NULL,
      verification_evidence = NULL, verification_version = verification_version + 1 WHERE id = $1 AND organization_id = $2 AND verification_status <> 'revoked' RETURNING verification_version`, [id, organizationId]);
    if (!started) throw new NotFoundException("An active AWS binding is required.");
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId").where("binding.id = :id AND binding.organizationId = :organizationId", { id, organizationId }).getOne();
    const principal = (this.trustPolicy(binding!.externalId).Statement[0].Principal).AWS;
    const sts = new STSClient({ region: binding!.regions[0], maxAttempts: 2 });
    let customerSts: STSClient | undefined;
    let iam: IAMClient | undefined;
    const signal = AbortSignal.timeout(30_000);
    try {
      const result = await sts.send(new AssumeRoleCommand({ RoleArn: binding!.roleArn, ExternalId: binding!.externalId, RoleSessionName: `dg-onboard-${id}`, DurationSeconds: 900 }), { abortSignal: signal });
      if (!result.Credentials?.AccessKeyId || !result.Credentials.SecretAccessKey || !result.Credentials.SessionToken) throw new Error("temporary_credentials_missing");
      const credentials = { accessKeyId: result.Credentials.AccessKeyId, secretAccessKey: result.Credentials.SecretAccessKey, sessionToken: result.Credentials.SessionToken };
      customerSts = new STSClient({ region: binding!.regions[0], credentials, maxAttempts: 2 });
      iam = new IAMClient({ region: binding!.regions[0], credentials, maxAttempts: 2 });
      const identity = await customerSts.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
      const roleName = binding!.roleArn.split("/").pop()!;
      if (identity.Account !== binding!.accountId || !identity.Arn?.startsWith(`arn:aws:sts::${binding!.accountId}:assumed-role/${roleName}/`)) throw new Error("account_identity_mismatch");
      const role = (await iam.send(new GetRoleCommand({ RoleName: roleName }), { abortSignal: signal })).Role;
      if (role?.Arn !== binding!.roleArn || !role.AssumeRolePolicyDocument) throw new Error("role_identity_mismatch");
      validateCustomerRoleTrust(JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument)), principal, binding!.externalId);
      const actions = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeTargetHealth", "logs:DescribeLogGroups"];
      for (const region of binding!.regions) {
        const permissions = await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: binding!.roleArn, ActionNames: actions, ResourceArns: ["*"], ContextEntries: [{ ContextKeyName: "aws:RequestedRegion", ContextKeyType: "string", ContextKeyValues: [region] }] }), { abortSignal: signal });
        if (permissions.IsTruncated || actions.some((action) => !permissions.EvaluationResults?.some((entry) => entry.EvalActionName === action && entry.EvalDecision === "allowed" && !entry.MissingContextValues?.length))) throw new Error("required_read_permissions_missing");
      }
      const evidence = { accountIdentity: true, assumedRoleIdentity: true, externalIdTrust: true, readPermissions: actions, regionAllowlist: binding!.regions, mutationAuthority: "unverified", crossAccountDeployment: "unverified" };
      const [rows] = await this.database.query(`UPDATE aws_account_bindings SET verification_status = 'verified', verified_at = now(), verification_evidence = $4
        WHERE id = $1 AND organization_id = $2 AND verification_version = $3 AND verification_status = 'pending' RETURNING id`, [id, organizationId, started.verification_version, evidence]);
      if (!rows.length) throw new ConflictException("The AWS binding changed during verification.");
      await this.audit.record({ actorUser: user, action: "AWS_BINDING_VERIFIED", resourceType: "aws_binding", resourceId: id, status: "success", metadata: { organizationId, mutationAuthority: "unverified" } });
      return { status: "verified", evidence };
    } catch (error) {
      await this.database.query(`UPDATE aws_account_bindings SET verification_status = 'failed', verified_at = NULL WHERE id = $1 AND verification_version = $2 AND verification_status = 'pending'`, [id, started.verification_version]);
      if (error instanceof ConflictException) throw error;
      throw new BadRequestException("AWS binding verification failed. Check account identity, external-ID trust, permitted regions and read permissions. Deployment authority remains disabled.");
    } finally { sts.destroy(); customerSts?.destroy(); iam?.destroy(); }
  }

  async revoke(user: User, organizationId: string, id: string) {
    await this.workspaces.assertMembership(user, organizationId, true);
    const [rows] = await this.database.query(`UPDATE aws_account_bindings SET verification_status = 'revoked', verified_at = NULL,
      verification_version = verification_version + 1 WHERE id = $1 AND organization_id = $2 RETURNING id`, [id, organizationId]);
    if (!rows.length) throw new NotFoundException("AWS binding not found.");
    await this.audit.record({ actorUser: user, action: "AWS_BINDING_REVOKED", resourceType: "aws_binding", resourceId: id, status: "success", metadata: { organizationId } });
  }
}
