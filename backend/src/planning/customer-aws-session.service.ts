import { customerMutationAuthorized } from "../workspaces/customer-authority-proof";
import { customerControlPlanePrincipal } from "../workspaces/customer-control-plane-principal";
import { HostingProfileRegistryService } from "./hosting-profile-registry.service";
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DataSource } from "typeorm";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { Project, ProjectStatus } from "../projects/project.entity";
import { DeploymentPlan, DeploymentPlanDecision } from "./deployment-plan.entity";
import { hostingCatalog, planFingerprint } from "./deployment-plan";
import type { CustomerExecutionContext } from "../projects/customer-execution-context";

export type CustomerSessionScope = {
  organizationId: string; bindingId: string; region: string; projectId: string; operationId: string;
  purpose: "read" | "restart" | "replicas";
};
export type CustomerAwsContext = { accountId: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ecsSessionPolicy(scope: CustomerSessionScope & { accountId: string }) {
  if (![scope.organizationId, scope.bindingId, scope.projectId, scope.operationId].every((value) => UUID.test(value)) || !/^\d{12}$/.test(scope.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(scope.region) || !["read", "restart", "replicas"].includes(scope.purpose)) throw new ConflictException("Invalid customer AWS session scope.");
  const name = `dg-${scope.projectId.replaceAll("-", "").slice(0, 12)}`;
  const prefix = `arn:aws:ecs:${scope.region}:${scope.accountId}`;
  const Statement: any[] = [{ Effect: "Allow", Action: ["ecs:DescribeClusters", "ecs:DescribeServices", "ecs:ListTagsForResource"],
    Resource: [`${prefix}:cluster/${name}`, `${prefix}:service/${name}/${name}-*`] },
    { Effect: "Allow", Action: ["ecs:DescribeTaskDefinition"], Resource: [`${prefix}:task-definition/${name}-*:*`] }];
  if (scope.purpose === "read") Statement.push({ Effect: "Allow", Action: ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth"], Resource: "*",
    Condition: { StringEquals: { "aws:RequestedRegion": scope.region } } });
  if (scope.purpose === "read") Statement.push({ Effect: "Allow", Action: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"], Resource: [`arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/${scope.projectId}/services/*:*`, `arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/${scope.projectId}/*/database:*`] });
  if (scope.purpose !== "read") Statement.push({ Effect: "Allow", Action: ["ecs:UpdateService"], Resource: [`${prefix}:service/${name}/${name}-*`],
    Condition: { StringEquals: { "aws:ResourceTag/DeployGuardProjectId": scope.projectId }, ArnEquals: { "ecs:cluster": `${prefix}:cluster/${name}` } } });
  return { Version: "2012-10-17", Statement };
}

@Injectable()
export class CustomerAwsSessionService {
  constructor(private readonly database: DataSource, private readonly config: ConfigService, private readonly profiles?: HostingProfileRegistryService) {}
  async withEcsSession<T>(scope: CustomerSessionScope, callback: (context: CustomerAwsContext) => Promise<T>): Promise<T> {
    return this.withSession(scope, ecsSessionPolicy({ ...scope, accountId: "000000000000" }), callback, true);
  }
  async withApprovedDeploymentSession<T>(scope: Omit<CustomerExecutionContext, "credentials">, callback: (context: CustomerExecutionContext) => Promise<T>): Promise<T> {
    const plan = await this.database.getRepository(DeploymentPlan).findOneBy({ id: scope.planId, projectId: scope.projectId, organizationId: scope.organizationId });
    const decision = await this.database.getRepository(DeploymentPlanDecision).findOneBy({ planId: scope.planId });
    if (!plan || !decision || decision.decision !== "approved" || plan.fingerprint !== scope.planFingerprint || planFingerprint(plan.content) !== scope.planFingerprint || decision.fingerprint !== scope.planFingerprint || decision.operationId !== scope.operationId || plan.content.operationId !== scope.operationId || plan.content.status !== "review_required" || plan.content.blockers.length || plan.content.selectedProfile !== "ecs_fargate" || !this.profiles?.available("ecs_fargate", scope.region)) throw new ConflictException("A current approved and available customer ECS deployment plan is required.");
    if ((plan.content.deploymentAction || "deploy") !== scope.deploymentAction || planFingerprint(plan.content.lifecycle || null) !== planFingerprint(scope.lifecycle || null) || planFingerprint(plan.content.retry || null) !== planFingerprint(scope.retry || null)) throw new ConflictException("Customer lifecycle action differs from the immutable approval.");
    const ownership = plan.content.ownership;
    if (ownership.bindingId !== scope.bindingId || ownership.accountId !== scope.accountId || ownership.region !== scope.region || ownership.environment !== scope.environmentName || ownership.bindingVersion !== scope.bindingVersion || planFingerprint(plan.content.infrastructure) !== planFingerprint({ vpcId: scope.vpcId, publicSubnetIds: scope.publicSubnetIds, terraformStateBucket: scope.terraformStateBucket, executionRolePermissionsBoundaryArn: scope.executionRolePermissionsBoundaryArn })) throw new ConflictException("Customer deployment resources differ from the immutable approval.");
    const resourcePrefix = `arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/${scope.projectId}/${scope.environmentName}/*`;
    const policy = { Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["iam:SimulatePrincipalPolicy", "iam:GetRole"], Resource: scope.roleArn },
      { Effect: "Allow", Action: ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource: scope.executionRolePermissionsBoundaryArn },
      { Effect: "Allow", Action: ["ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeAccessPoints"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": scope.region } } },
      { Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: `arn:aws:s3:::${scope.terraformStateBucket}` },
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: `arn:aws:s3:::${scope.terraformStateBucket}/projects/${scope.projectId}/${scope.environmentName}/runtime/*` },
      { Effect: "Allow", Action: ["secretsmanager:DescribeSecret"], Resource: resourcePrefix },
      { Effect: "Allow", Action: ["secretsmanager:PutSecretValue", "secretsmanager:RestoreSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:DeleteSecret"], Resource: resourcePrefix, Condition: { StringEquals: { "aws:ResourceTag/DeployGuardProjectId": scope.projectId } } },
      { Effect: "Allow", Action: ["secretsmanager:CreateSecret"], Resource: resourcePrefix, Condition: { StringEquals: { "aws:RequestTag/DeployGuardProjectId": scope.projectId } } },
    ] };
    return this.withSession({ ...scope, purpose: "restart" }, policy, (context) => callback({ ...scope, ...context }));
  }
  private async withSession<T>(scope: CustomerSessionScope, policy: Record<string, unknown>, callback: (context: CustomerAwsContext) => Promise<T>, ecsPolicy = false): Promise<T> {
    // Validate before querying authorization or contacting AWS.
    ecsSessionPolicy({ ...scope, accountId: "000000000000" });
    const project = await this.database.getRepository(Project).findOneBy({ id: scope.projectId, organizationId: scope.organizationId });
    if (!project || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId || (project.awsAccountBindingId && project.awsAccountBindingId !== scope.bindingId)) throw new NotFoundException("Active project ownership does not match the AWS session scope.");
    if (scope.purpose !== "read") await this.assertActiveOrganization(scope.organizationId);
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId")
      .where("binding.id = :id AND binding.organizationId = :organizationId", { id: scope.bindingId, organizationId: scope.organizationId }).getOne();
    if (!binding || binding.verificationStatus === "revoked") throw new NotFoundException("Active workspace AWS binding not found.");
    const verificationVersion = binding.verificationVersion;
    if (binding.verificationStatus !== "verified" || !binding.verifiedAt || !binding.regions.includes(scope.region)) throw new ConflictException("Customer AWS account identity or region authorization is unavailable.");
    if (scope.purpose !== "read" && !customerMutationAuthorized(this.config, binding, scope.projectId)) throw new ConflictException("Customer AWS mutation authority has not been verified.");
    if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(binding.roleArn) || binding.roleArn.split(":")[4] !== binding.accountId || !binding.externalId) throw new ConflictException("Customer AWS role binding is invalid.");
    const controlRole = customerControlPlanePrincipal(this.config);
    if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(controlRole)) throw new ServiceUnavailableException("Customer AWS control-plane role is not configured.");
    const scopedPolicy = JSON.stringify(ecsPolicy ? ecsSessionPolicy({ ...scope, accountId: binding.accountId }) : policy);
    if (scopedPolicy.length > 2048) throw new ConflictException("Customer session policy exceeds the supported AWS scope limit.");
    const sts = new STSClient({ region: scope.region, maxAttempts: 1 });
    let identityClient: STSClient | null = null;
    let context: CustomerAwsContext;
    try {
      const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: binding.roleArn, ExternalId: binding.externalId,
        RoleSessionName: `deployguard-${scope.operationId}`, DurationSeconds: 900,
        Policy: scopedPolicy }), { abortSignal: AbortSignal.timeout(15000) });
      const credentials = assumed.Credentials;
      if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration || credentials.Expiration.getTime() < Date.now() + 60000) throw new Error("Temporary credential response invalid.");
      context = { accountId: binding.accountId, region: scope.region, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration: credentials.Expiration } };
      identityClient = new STSClient({ region: scope.region, credentials: context.credentials, maxAttempts: 1 });
      const identity = await identityClient.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
      const roleName = binding.roleArn.split("/").at(-1);
      if (identity.Account !== binding.accountId || !identity.Arn?.startsWith(`arn:aws:sts::${binding.accountId}:assumed-role/${roleName}/`)) throw new Error("Customer account or role identity changed.");
    } catch { throw new ServiceUnavailableException("The authorized customer AWS session could not be established. No mutation was dispatched."); }
    finally { sts.destroy(); identityClient?.destroy(); }
    const current = await this.database.getRepository(AwsAccountBinding).findOneBy({ id: scope.bindingId, organizationId: scope.organizationId });
    if (!current || current.verificationStatus !== "verified" || current.verificationVersion !== verificationVersion || !current.regions.includes(scope.region) || (scope.purpose !== "read" && !customerMutationAuthorized(this.config, current, scope.projectId))) throw new ConflictException("Customer AWS authorization changed before execution. No mutation was dispatched.");
    if (scope.purpose !== "read") await this.assertActiveOrganization(scope.organizationId);
    // Credentials remain local to the callback and are never included in audit/event/result documents.
    return callback(context!);
  }
  private async assertActiveOrganization(id: string) {
    const [organization] = await this.database.query(`SELECT archived_at FROM organizations WHERE id = $1`, [id]);
    if (!organization || organization.archived_at) throw new ConflictException("Archived workspaces cannot execute AWS mutations.");
  }
}
