import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { planFingerprint } from "../planning/deployment-plan";
import { AwsCliService } from "../state-management/aws-cli.service";
import type { CustomerExecutionContext } from "./customer-execution-context";

@Injectable()
export class CustomerWorkflowBindingService {
  constructor(private readonly database: DataSource, private readonly config: ConfigService, private readonly aws: AwsCliService) {}
  async verifyInfrastructure(context: CustomerExecutionContext) {
    const [vpc, subnets, bucket, routes] = await Promise.all([
      this.aws.runScoped(["ec2", "describe-vpcs", "--vpc-ids", context.vpcId, "--output", "json"], context),
      this.aws.runScoped(["ec2", "describe-subnets", "--subnet-ids", ...context.publicSubnetIds, "--output", "json"], context),
      this.aws.runScoped(["s3api", "get-bucket-location", "--bucket", context.terraformStateBucket, "--expected-bucket-owner", context.accountId, "--output", "json"], context),
      this.aws.runScoped(["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${context.vpcId}`, "--output", "json"], context),
    ]);
    const networks = JSON.parse(vpc.stdout).Vpcs || [], selected = JSON.parse(subnets.stdout).Subnets || [];
    const location = JSON.parse(bucket.stdout).LocationConstraint || "us-east-1";
    if (networks.length !== 1 || networks[0].VpcId !== context.vpcId || networks[0].OwnerId !== context.accountId || networks[0].State !== "available" || location !== context.region) throw new ConflictException("Approved VPC or Terraform state bucket is outside the customer account/region.");
    if (selected.length !== context.publicSubnetIds.length || new Set(selected.map((item: any) => item.AvailabilityZone)).size < 2 || selected.some((item: any) => !context.publicSubnetIds.includes(item.SubnetId) || item.VpcId !== context.vpcId || item.OwnerId !== context.accountId || item.State !== "available")) throw new ConflictException("Approved customer subnets do not provide an owned multi-zone ALB network.");
    const tables = JSON.parse(routes.stdout).RouteTables || [];
    for (const subnet of selected) {
      const table = tables.find((item: any) => item.Associations?.some((association: any) => association.SubnetId === subnet.SubnetId)) || tables.find((item: any) => item.Associations?.some((association: any) => association.Main === true));
      if (!table?.Routes?.some((route: any) => route.DestinationCidrBlock === "0.0.0.0/0" && route.GatewayId?.startsWith("igw-") && route.State === "active")) throw new ConflictException("Approved subnets lack a verified public Internet route.");
    }
  }
  async materialize(context: CustomerExecutionContext) {
    const role = this.config.get<string>("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "").trim();
    if (!role || role !== this.config.get<string>("AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN", "").trim()) throw new ServiceUnavailableException("GitHub OIDC and customer trust must use the same configured control-plane principal.");
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId")
      .where("binding.id = :id AND binding.organizationId = :organizationId", { id: context.bindingId, organizationId: context.organizationId }).getOne();
    if (!binding || binding.verificationStatus !== "verified" || binding.verificationVersion !== context.bindingVersion || binding.accountId !== context.accountId || binding.roleArn !== context.roleArn) throw new ConflictException("AWS binding changed before workflow authorization.");
    const identity = new STSClient({ region: context.region, maxAttempts: 1 });
    const client = new SecretsManagerClient({ region: context.region, maxAttempts: 1 });
    const name = `deployguard/customer-bindings/${context.organizationId}/${context.bindingId}`;
    const tags = { ManagedBy: "DeployGuard", DeployGuardOrganizationId: context.organizationId, DeployGuardBindingId: context.bindingId };
    try {
      const caller = await identity.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
      const account = role.split(":")[4], roleName = role.split("/").at(-1);
      if (caller.Account !== account || !caller.Arn?.startsWith(`arn:aws:sts::${account}:assumed-role/${roleName}/`)) throw new Error("Control-plane identity mismatch.");
      let existing;
      try { existing = await client.send(new DescribeSecretCommand({ SecretId: name }), { abortSignal: AbortSignal.timeout(10000) }); }
      catch (error) { if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error; }
      const SecretString = JSON.stringify({ contractVersion: "deployguard.customer-binding/v1", organizationId: context.organizationId, bindingId: binding.id, bindingVersion: binding.verificationVersion, accountId: binding.accountId, roleArn: binding.roleArn, externalId: binding.externalId });
      const ClientRequestToken = planFingerprint({ bindingId: binding.id, version: binding.verificationVersion });
      if (existing) {
        const actual = Object.fromEntries((existing.Tags || []).map((item) => [item.Key, item.Value]));
        if (existing.DeletedDate || existing.Name !== name || Object.entries(tags).some(([key, value]) => actual[key] !== value)) throw new Error("Workflow binding secret ownership mismatch.");
        await client.send(new PutSecretValueCommand({ SecretId: existing.ARN, SecretString, ClientRequestToken }), { abortSignal: AbortSignal.timeout(10000) });
      } else existing = await client.send(new CreateSecretCommand({ Name: name, SecretString, ClientRequestToken, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }), { abortSignal: AbortSignal.timeout(10000) });
      if (!existing.ARN?.startsWith(`arn:aws:secretsmanager:${context.region}:${account}:secret:${name}-`)) throw new Error("Workflow binding secret account mismatch.");
      return { arn: existing.ARN, controlRoleArn: role };
    } catch { throw new ServiceUnavailableException("Protected customer workflow authorization could not be prepared. No workflow was dispatched."); }
    finally { identity.destroy(); client.destroy(); }
  }
}
