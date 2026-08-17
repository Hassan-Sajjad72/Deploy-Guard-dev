import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeClustersCommand, DescribeServicesCommand, ListTaskDefinitionsCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DescribeLogGroupsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseImageProvenance } from "../entities/release-image-provenance.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { InactiveV1ReleaseLaneCompositionService } from "./inactive-v1-release-lane-composition";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[1-9][0-9]*$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const ARN = /^arn:(?:aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:.+$/;
const ECR = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*$/;
const SG = /^sg-[a-z0-9]+$/;
const LOG = /^\/[A-Za-z0-9_./#-]{1,511}$/;
const execFile = promisify(execFileCallback);

export type FirstReleaseIdentityPreflightResult = Readonly<{
  state: "disabled" | "blocked" | "ready";
  safeCodes: readonly string[];
  manifestVerified: boolean;
  foundationVerified: boolean;
  releaseEvidenceAbsent: boolean;
  serviceAbsent: boolean;
  taskDefinitionAbsent: boolean;
}>;

type Scope = { projectId: string; manifestId: string; revision: string; region: string };
type Clients = { ecr: ECRClient; ecs: ECSClient; elbv2: ElasticLoadBalancingV2Client; logs: CloudWatchLogsClient };

/** Explicit one-shot inspection. It has no queue, consumer, ownership, or mutation path. */
@Injectable()
export class ProductionV1FirstReleaseIdentityPreflightService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly composition: InactiveV1ReleaseLaneCompositionService,
  ) {}

  async run(): Promise<FirstReleaseIdentityPreflightResult> {
    const scope = this.scope();
    if (!scope) return this.result("disabled", ["FIRST_RELEASE_IDENTITY_PREFLIGHT_DISABLED"]);
    const composition = this.composition.getInactiveComposition();
    if (!composition?.firstReleaseBootstrap || !composition.allows(scope.projectId, "dev")) {
      return this.result("blocked", ["FIRST_RELEASE_COMPOSITION_NOT_READY"]);
    }
    const manifest = await this.dataSource.getRepository(InfrastructureManifest).findOne({
      where: { id: scope.manifestId, projectId: scope.projectId, environmentName: "dev", revision: scope.revision, status: "applied" },
    });
    if (!manifest || !manifest.terraformOutputs || !manifest.terraformOutputsHash
      || canonicalSha256(manifest.terraformOutputs) !== manifest.terraformOutputsHash) {
      return this.result("blocked", ["FIRST_RELEASE_APPLIED_MANIFEST_INVALID"]);
    }
    let releases: number;
    let provenance: number;
    try {
      releases = await this.dataSource.getRepository(ReleaseManifest).count({ where: { projectId: scope.projectId, environmentName: "dev", infrastructureManifestId: manifest.id } });
      provenance = await this.dataSource.getRepository(ReleaseImageProvenance).count({ where: { projectId: scope.projectId, environmentName: "dev", infrastructureManifestId: manifest.id, infrastructureRevision: manifest.revision } });
    } catch {
      return this.result("blocked", ["FIRST_RELEASE_PROVENANCE_SCHEMA_UNAVAILABLE"], true);
    }
    if (releases !== 0 || provenance !== 0) return this.result("blocked", ["FIRST_RELEASE_EVIDENCE_ALREADY_EXISTS"], true, false, false);
    const values = this.outputs(
      manifest.terraformOutputs,
      manifest.desiredSpec.ecsFoundation.serviceName,
    );
    if (!values) return this.result("blocked", ["FIRST_RELEASE_FOUNDATION_OUTPUTS_INVALID"], true, false, true);
    const clients = this.clients(scope.region);
    try {
      const repository = await clients.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [values.repositoryName] }));
      const ecrOk = repository.repositories?.length === 1 && repository.repositories[0]?.repositoryUri === values.repositoryUrl;
      const clusters = await clients.ecs.send(new DescribeClustersCommand({ clusters: [values.clusterArn] }));
      const clusterOk = clusters.clusters?.length === 1 && clusters.clusters[0]?.status === "ACTIVE";
      const targetGroups = await clients.elbv2.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [values.targetGroupArn] }));
      const targetGroupOk = targetGroups.TargetGroups?.length === 1;
      const subnets = await this.awsJson(["ec2", "describe-subnets", "--subnet-ids", ...values.subnetIds, "--region", scope.region]);
      const subnetsOk = Array.isArray(subnets.Subnets) && subnets.Subnets.length === values.subnetIds.length;
      const groups = await this.awsJson(["ec2", "describe-security-groups", "--group-ids", ...values.securityGroupIds, "--region", scope.region]);
      const groupOk = Array.isArray(groups.SecurityGroups) && groups.SecurityGroups.length === values.securityGroupIds.length;
      const roles = await Promise.all(values.roleArns.map((arn) => this.awsJson(["iam", "get-role", "--role-name", arn.split("/").pop()!])));
      const rolesOk = roles.every((entry) => typeof entry.Role?.Arn === "string");
      const logs = await clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: values.logGroupName }));
      const logsOk = logs.logGroups?.some((entry) => entry.logGroupName === values.logGroupName) === true;
      const service = await clients.ecs.send(new DescribeServicesCommand({ cluster: values.clusterArn, services: [values.serviceName] }));
      const serviceAbsent = service.services?.length === 0 && service.failures?.length === 1 && service.failures[0]?.reason === "MISSING";
      const family = `deployguard-${scope.projectId.slice(0, 8)}`;
      const tasks = await clients.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: "ACTIVE", sort: "DESC" }));
      const taskDefinitionAbsent = (tasks.taskDefinitionArns?.length ?? 0) === 0;
      const foundationVerified = ecrOk && clusterOk && targetGroupOk && subnetsOk && groupOk && rolesOk && logsOk;
      const codes: string[] = [];
      if (!foundationVerified) codes.push("FIRST_RELEASE_FOUNDATION_IDENTITY_MISMATCH");
      if (!serviceAbsent) codes.push("FIRST_RELEASE_SERVICE_NOT_ABSENT");
      if (!taskDefinitionAbsent) codes.push("FIRST_RELEASE_TASK_DEFINITION_NOT_ABSENT");
      return this.result(codes.length ? "blocked" : "ready", codes.length ? codes : ["FIRST_RELEASE_IDENTITY_READY"], true, foundationVerified, true, serviceAbsent, taskDefinitionAbsent);
    } catch {
      return this.result("blocked", ["FIRST_RELEASE_READ_ONLY_INSPECTION_FAILED"], true, false, true);
    }
  }

  private scope(): Scope | null {
    if (this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_PREFLIGHT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_PREFLIGHT_MODE") !== "read_only") return null;
    const projectId = this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
    const manifestId = this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_MANIFEST_ID");
    const revision = this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_REVISION");
    const region = this.config.get<unknown>("AWS_REGION");
    return typeof projectId === "string" && UUID.test(projectId) && typeof manifestId === "string" && UUID.test(manifestId) && typeof revision === "string" && REVISION.test(revision) && typeof region === "string" && REGION.test(region)
      ? { projectId, manifestId, revision, region } : null;
  }

  private outputs(value: Record<string, unknown>, expectedServiceName: string) {
    const string = (key: string, pattern: RegExp) => typeof value[key] === "string" && pattern.test(value[key] as string) ? value[key] as string : null;
    const repositoryUrl = string("ecr_repository_url", ECR); const repositoryName = string("ecr_repository_name", /^[A-Za-z0-9_./-]{1,256}$/);
    const clusterArn = string("ecs_cluster_arn", ARN); const targetGroupArn = string("alb_target_group_arn", ARN);
    const securityGroupId = string("app_security_group_id", SG); const databaseSecurityGroupId = string("database_security_group_id", SG); const logGroupName = string("ecs_log_group_name", LOG);
    const executionRole = string("ecs_execution_role_arn", ARN); const taskRole = string("ecs_task_role_arn", ARN);
    const managed = value.canary_ecs_assign_public_ip === false && value.database_enabled === true;
    const selectedSubnets = managed ? value.private_subnet_ids : value.public_subnet_ids;
    const subnetIds = Array.isArray(selectedSubnets) && selectedSubnets.length > 0 && selectedSubnets.every((id) => typeof id === "string" && /^subnet-[a-z0-9]+$/.test(id)) ? [...selectedSubnets] as string[] : null;
    const serviceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(expectedServiceName)
      ? expectedServiceName : null;
    const managedOutputs = !managed || (
      databaseSecurityGroupId
      && string("database_internal_host", /^db\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/)
      && string("database_password_secret_arn", /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:/)
      && string("database_url_secret_arn", /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:/)
      && string("application_jwt_secret_arn", /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:/)
    );
    return repositoryUrl && repositoryName && clusterArn && targetGroupArn && securityGroupId && logGroupName && executionRole && taskRole && subnetIds && (managed || value.canary_ecs_assign_public_ip === true) && managedOutputs
      ? { repositoryUrl, repositoryName, clusterArn, targetGroupArn, securityGroupIds: managed ? [securityGroupId, databaseSecurityGroupId!].sort() : [securityGroupId], logGroupName, roleArns: [executionRole, taskRole], subnetIds, serviceName } : null;
  }

  private clients(region: string): Clients { return { ecr: new ECRClient({ region }), ecs: new ECSClient({ region }), elbv2: new ElasticLoadBalancingV2Client({ region }), logs: new CloudWatchLogsClient({ region }) }; }
  private async awsJson(args: string[]): Promise<any> {
    const { stdout } = await execFile("aws", [...args, "--output", "json", "--no-cli-pager"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  private result(state: FirstReleaseIdentityPreflightResult["state"], safeCodes: readonly string[], manifestVerified = false, foundationVerified = false, releaseEvidenceAbsent = false, serviceAbsent = false, taskDefinitionAbsent = false): FirstReleaseIdentityPreflightResult { return Object.freeze({ state, safeCodes: Object.freeze([...new Set(safeCodes)].sort()), manifestVerified, foundationVerified, releaseEvidenceAbsent, serviceAbsent, taskDefinitionAbsent }); }
}
