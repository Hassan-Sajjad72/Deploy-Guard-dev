import { createHash } from "node:crypto";
import { customerMutationAuthorized, validateCustomerAuthorityProof } from "../workspaces/customer-authority-proof";
import { customerControlPlanePrincipal } from "../workspaces/customer-control-plane-principal";
import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { CreateSecretCommand, DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GetRoleCommand, GetRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand } from "@aws-sdk/client-iam";
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
  async materialize(context: CustomerExecutionContext, oidcSubjects: string[], runtimePayload: string, controlPlaneSha: string) {
    const role = customerControlPlanePrincipal(this.config);
    if (!role) throw new ServiceUnavailableException("Customer control-plane principal is unavailable.");
    const binding = await this.database.getRepository(AwsAccountBinding).createQueryBuilder("binding").addSelect("binding.externalId")
      .where("binding.id = :id AND binding.organizationId = :organizationId", { id: context.bindingId, organizationId: context.organizationId }).getOne();
    if (!binding || binding.verificationStatus !== "verified" || binding.verificationVersion !== context.bindingVersion || binding.accountId !== context.accountId || binding.roleArn !== context.roleArn || !customerMutationAuthorized(this.config, binding, context.projectId)) throw new ConflictException("AWS binding changed before workflow authorization.");
    const proof = validateCustomerAuthorityProof(this.config, binding.verificationEvidence?.authorityProof, binding, context.projectId)!;
    const brokerRoleArn = proof.workflowBrokerRoles[context.projectId];
    const identity = new STSClient({ region: context.region, maxAttempts: 1 });
    const client = new SecretsManagerClient({ region: context.region, maxAttempts: 1 });
    const name = `deployguard/customer-operations/${context.organizationId}/${context.projectId}/${context.operationId}`;
    const tags = { ManagedBy: "DeployGuard", DeployGuardOrganizationId: context.organizationId, DeployGuardBindingId: context.bindingId, DeployGuardProjectId: context.projectId, DeployGuardOperationId: context.operationId };
    try {
      const caller = await identity.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
      const account = role.split(":")[4], roleName = role.split("/").at(-1);
      if (caller.Account !== account || !caller.Arn?.startsWith(`arn:aws:sts::${account}:assumed-role/${roleName}/`)) throw new Error("Control-plane identity mismatch.");
      let existing;
      try { existing = await client.send(new DescribeSecretCommand({ SecretId: name }), { abortSignal: AbortSignal.timeout(10000) }); }
      catch (error) { if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error; }
      const authorization = { planId: context.planId, planFingerprint: context.planFingerprint, projectId: context.projectId, operationId: context.operationId, sourceSha: context.sourceSha, controlPlaneSha, runtimePayloadSha256: createHash("sha256").update(runtimePayload).digest("hex"), environment: context.environmentName, deploymentAction: context.deploymentAction, configurationFingerprint: context.configurationFingerprint, assumptions: context.assumptions, infrastructure: { vpcId: context.vpcId, publicSubnetIds: context.publicSubnetIds, terraformStateBucket: context.terraformStateBucket, executionRolePermissionsBoundaryArn: context.executionRolePermissionsBoundaryArn }, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      const SecretString = JSON.stringify({ contractVersion: "deployguard.customer-binding/v1", organizationId: context.organizationId, bindingId: binding.id, bindingVersion: binding.verificationVersion, accountId: binding.accountId, roleArn: binding.roleArn, externalId: binding.externalId, authorization, authorityProofFingerprint: binding.verificationEvidence?.authorityProofFingerprint, authorityProof: (binding.verificationEvidence?.authorityProof as any)?.proof });
      const ClientRequestToken = planFingerprint({ operationId: context.operationId, planId: context.planId, fingerprint: context.planFingerprint });
      const [organization] = await this.database.query(`SELECT id FROM organizations WHERE id = $1 AND archived_at IS NULL`, [context.organizationId]);
      if (!organization) throw new Error("Customer workspace archive changed.");
      if (existing) {
        const actual = Object.fromEntries((existing.Tags || []).map((item) => [item.Key, item.Value]));
        if (existing.DeletedDate || existing.Name !== name || Object.entries(tags).some(([key, value]) => actual[key] !== value)) throw new Error("Workflow binding secret ownership mismatch.");
        throw new Error("An immutable customer operation authorization already exists; create a new reviewed operation.");
      } else existing = await client.send(new CreateSecretCommand({ Name: name, SecretString, ClientRequestToken, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }), { abortSignal: AbortSignal.timeout(10000) });
      if (!existing.ARN?.startsWith(`arn:aws:secretsmanager:${context.region}:${account}:secret:${name}-`)) throw new Error("Workflow binding secret account mismatch.");
      await this.verifyBroker(context, brokerRoleArn, existing.ARN, binding.externalId, oidcSubjects);
      return { arn: existing.ARN, controlRoleArn: brokerRoleArn };
    } catch { throw new ServiceUnavailableException("Protected customer workflow authorization could not be prepared. No workflow was dispatched."); }
    finally { identity.destroy(); client.destroy(); }
  }

  private async verifyBroker(context: CustomerExecutionContext, brokerRoleArn: string, secretArn: string, externalId: string, oidcSubjects: string[]) {
    const client = new IAMClient({ region: context.region, maxAttempts: 1 });
    const customer = new IAMClient({ region: context.region, credentials: context.credentials, maxAttempts: 1 });
    const decode = (value: string | undefined) => { if (!value) throw new Error("Broker policy missing."); try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); } };
    const roleName = brokerRoleArn.split("/").at(-1)!;
    try {
      const [broker, inline, attached, trustedCustomer] = await Promise.all([
        client.send(new GetRoleCommand({ RoleName: roleName })), client.send(new ListRolePoliciesCommand({ RoleName: roleName })),
        client.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })), customer.send(new GetRoleCommand({ RoleName: context.roleArn.split("/").at(-1)! })),
      ]);
      if (broker.Role?.Arn !== brokerRoleArn || inline.IsTruncated || attached.IsTruncated || attached.AttachedPolicies?.length || JSON.stringify(inline.PolicyNames) !== JSON.stringify(["DeployGuardCustomerBroker"])) throw new Error("Broker must have exactly its scoped inline policy.");
      const trust = decode(broker.Role.AssumeRolePolicyDocument), statements = Array.isArray(trust.Statement) ? trust.Statement : [trust.Statement];
      if (!oidcSubjects.length || statements.length !== 1 || statements[0].Effect !== "Allow" || statements[0].Action !== "sts:AssumeRoleWithWebIdentity" || statements[0].Principal?.Federated !== `arn:aws:iam::${brokerRoleArn.split(":")[4]}:oidc-provider/token.actions.githubusercontent.com` || Object.keys(statements[0].Principal).length !== 1 || Object.keys(statements[0].Condition || {}).length !== 1 || statements[0].Condition.StringEquals?.["token.actions.githubusercontent.com:aud"] !== "sts.amazonaws.com") throw new Error("Broker trust is not restricted to GitHub OIDC.");
      const subjects = [statements[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]].flat();
      if (!subjects.length || subjects.some((subject: unknown) => typeof subject !== "string" || !oidcSubjects.includes(subject))) throw new Error("Broker trust must match the exact caller and pinned reusable workflow.");
      const expected = { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: `arn:aws:secretsmanager:${context.region}:${brokerRoleArn.split(":")[4]}:secret:deployguard/customer-operations/${context.organizationId}/${context.projectId}/*` },
        { Effect: "Allow", Action: "sts:AssumeRole", Resource: context.roleArn, Condition: { StringEquals: { "sts:ExternalId": externalId } } },
      ] };
      const policy = await client.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: "DeployGuardCustomerBroker" }));
      if (planFingerprint(decode(policy.PolicyDocument)) !== planFingerprint(expected)) throw new Error("Broker permissions differ from exact binding-read/customer-assume authority.");
      const customerTrust = decode(trustedCustomer.Role?.AssumeRolePolicyDocument);
      const customerStatements = [customerTrust.Statement].flat();
      if (!customerStatements.some((entry: any) => entry.Effect === "Allow" && [entry.Action].flat().includes("sts:AssumeRole") && [entry.Principal?.AWS].flat().includes(brokerRoleArn) && entry.Condition?.StringEquals?.["sts:ExternalId"] === externalId)) throw new Error("Customer role does not trust the isolated broker with the binding external ID.");
    } finally { client.destroy(); customer.destroy(); }
  }
}
