import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DataSource } from "typeorm";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { Project, ProjectStatus } from "../projects/project.entity";

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
    Resource: [`${prefix}:cluster/${name}`, `${prefix}:service/${name}/${name}-*`] }];
  if (scope.purpose !== "read") Statement.push({ Effect: "Allow", Action: ["ecs:UpdateService"], Resource: [`${prefix}:service/${name}/${name}-*`],
    Condition: { StringEquals: { "aws:ResourceTag/DeployGuardProjectId": scope.projectId }, ArnEquals: { "ecs:cluster": `${prefix}:cluster/${name}` } } });
  return { Version: "2012-10-17", Statement };
}

@Injectable()
export class CustomerAwsSessionService {
  constructor(private readonly database: DataSource, private readonly config: ConfigService) {}
  async withEcsSession<T>(scope: CustomerSessionScope, callback: (context: CustomerAwsContext) => Promise<T>): Promise<T> {
    // Validate before querying authorization or contacting AWS.
    ecsSessionPolicy({ ...scope, accountId: "000000000000" });
    const project = await this.database.getRepository(Project).findOneBy({ id: scope.projectId, organizationId: scope.organizationId });
    if (!project || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId || (project.awsAccountBindingId && project.awsAccountBindingId !== scope.bindingId)) throw new NotFoundException("Active project ownership does not match the AWS session scope.");
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId")
      .where("binding.id = :id AND binding.organizationId = :organizationId", { id: scope.bindingId, organizationId: scope.organizationId }).getOne();
    if (!binding || binding.verificationStatus === "revoked") throw new NotFoundException("Active workspace AWS binding not found.");
    const verificationVersion = binding.verificationVersion;
    if (binding.verificationStatus !== "verified" || !binding.verifiedAt || !binding.regions.includes(scope.region)) throw new ConflictException("Customer AWS account identity or region authorization is unavailable.");
    if (scope.purpose !== "read" && binding.verificationEvidence?.mutationAuthority !== "verified") throw new ConflictException("Customer AWS mutation authority has not been verified.");
    if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(binding.roleArn) || binding.roleArn.split(":")[4] !== binding.accountId || !binding.externalId) throw new ConflictException("Customer AWS role binding is invalid.");
    const controlRole = this.config.get<string>("AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN", "").trim();
    if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(controlRole)) throw new ServiceUnavailableException("Customer AWS control-plane role is not configured.");
    const sts = new STSClient({ region: scope.region, maxAttempts: 1 });
    let identityClient: STSClient | null = null;
    let context: CustomerAwsContext;
    try {
      const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: binding.roleArn, ExternalId: binding.externalId,
        RoleSessionName: `deployguard-${scope.operationId}`, DurationSeconds: 900,
        Policy: JSON.stringify(ecsSessionPolicy({ ...scope, accountId: binding.accountId })) }), { abortSignal: AbortSignal.timeout(15000) });
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
    if (!current || current.verificationStatus !== "verified" || current.verificationVersion !== verificationVersion || !current.regions.includes(scope.region) || (scope.purpose !== "read" && current.verificationEvidence?.mutationAuthority !== "verified")) throw new ConflictException("Customer AWS authorization changed before execution. No mutation was dispatched.");
    // Credentials remain local to the callback and are never included in audit/event/result documents.
    return callback(context!);
  }
}
