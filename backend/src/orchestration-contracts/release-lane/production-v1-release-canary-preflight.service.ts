import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
} from "@aws-sdk/client-ecs";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import {
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { DataSource } from "typeorm";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { V1_ECS_RELEASE_EVIDENCE_TAGS } from "../worker-runtime/disabled-v1-ecs-read-only-evidence.client";
import { InactiveV1ReleaseLaneCompositionService } from "./inactive-v1-release-lane-composition";

const execFile = promisify(execFileCallback);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_./:@+=,-]{1,512}$/;
const IAM_PRINCIPAL = /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:(?:role|user)\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;

export type ProductionCanaryPreflightResult = Readonly<{
  state: "disabled" | "blocked" | "ready";
  safeCodes: readonly string[];
  accountVerified: boolean;
  regionVerified: boolean;
  ecrRepositoryVerified: boolean;
  ecsFoundationVerified: boolean;
  loadBalancerVerified: boolean;
  identityTagsVerified: boolean;
  futureMutationPermissionsVerified: boolean;
}>;

type CanaryScope = Readonly<{
  projectId: string;
  environmentName: "dev";
  region: string;
  repository: string;
  cluster: string;
  service: string;
  targetGroup: string;
  iamPrincipalArn: string | null;
}>;

/** Read-only canary inspection. It is explicitly invoked; it never runs at Nest startup. */
@Injectable()
export class ProductionV1ReleaseCanaryPreflightService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly composition: InactiveV1ReleaseLaneCompositionService,
  ) {}

  async run(): Promise<ProductionCanaryPreflightResult> {
    const status = this.composition.getStatus();
    if (status.state === "disabled") return this.result("disabled", ["CANARY_DISABLED"]);
    if (status.state !== "ready" || status.mode !== "production_canary") {
      return this.result("blocked", ["CANARY_CONFIGURATION_INVALID"]);
    }
    const scope = this.scope();
    if (!scope) return this.result("blocked", ["CANARY_RESOURCE_CONFIGURATION_INVALID"]);

    const pair = await this.loadManifestPair(scope.projectId);
    if (!pair) return this.result("blocked", ["CANARY_MANIFEST_IDENTITY_MISSING"]);
    const safeCodes: string[] = [];
    let accountVerified = false;
    let regionVerified = false;
    let ecrRepositoryVerified = false;
    let ecsFoundationVerified = false;
    let loadBalancerVerified = false;
    let identityTagsVerified = false;
    let futureMutationPermissionsVerified = false;
    try {
      const ecr = new ECRClient({ region: scope.region });
      const ecs = new ECSClient({ region: scope.region });
      const elbv2 = new ElasticLoadBalancingV2Client({ region: scope.region });
      const repository = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [scope.repository] }));
      regionVerified = true;
      const ecrRepository = repository.repositories?.[0];
      const registryId = ecrRepository?.registryId;
      accountVerified = typeof registryId === "string" && /^[0-9]{12}$/.test(registryId);
      ecrRepositoryVerified = accountVerified
        && repository.repositories?.length === 1
        && typeof ecrRepository?.repositoryUri === "string"
        && typeof pair.release.imageDigest === "string"
        && pair.release.imageUri === ecrRepository.repositoryUri;
      if (!ecrRepositoryVerified) safeCodes.push("CANARY_ECR_REPOSITORY_MISSING_OR_AMBIGUOUS");

      const clusters = await ecs.send(new DescribeClustersCommand({ clusters: [scope.cluster] }));
      const cluster = clusters.clusters?.[0];
      const services = await ecs.send(new DescribeServicesCommand({ cluster: scope.cluster, services: [scope.service], include: ["TAGS"] }));
      const service = services.services?.[0];
      ecsFoundationVerified = clusters.clusters?.length === 1
        && cluster?.status === "ACTIVE"
        && services.services?.length === 1
        && service?.status === "ACTIVE"
        && typeof service.taskDefinition === "string";
      if (!ecsFoundationVerified) safeCodes.push("CANARY_ECS_FOUNDATION_MISSING_OR_AMBIGUOUS");

      const task = ecsFoundationVerified
        ? await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: service!.taskDefinition!, include: ["TAGS"] }))
        : null;
      identityTagsVerified = Boolean(task && await this.matchesExactIdentityTags(
        task.tags ?? [],
        pair.infrastructure,
        pair.release,
      ));
      identityTagsVerified = identityTagsVerified
        && service?.taskDefinition === pair.release.taskDefinitionArn
        && task?.taskDefinition?.taskDefinitionArn === pair.release.taskDefinitionArn
        && task?.taskDefinition?.containerDefinitions?.length === 1
        && task.taskDefinition.containerDefinitions[0].image
          === `${pair.release.imageUri}@${pair.release.imageDigest}`;
      if (!identityTagsVerified) safeCodes.push("CANARY_ECS_IDENTITY_TAGS_MISMATCH");

      const targetGroups = await elbv2.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [scope.targetGroup] }));
      loadBalancerVerified = targetGroups.TargetGroups?.length === 1
        && Array.isArray(targetGroups.TargetGroups?.[0]?.LoadBalancerArns)
        && targetGroups.TargetGroups![0].LoadBalancerArns!.length === 1;
      if (!loadBalancerVerified) safeCodes.push("CANARY_LOAD_BALANCER_OR_TARGET_GROUP_MISSING_OR_AMBIGUOUS");

      futureMutationPermissionsVerified = await this.verifyPermissions(scope);
      if (!futureMutationPermissionsVerified) safeCodes.push("CANARY_FUTURE_MUTATION_PERMISSION_UNPROVEN");
    } catch {
      safeCodes.push("CANARY_READ_ONLY_AWS_PREFLIGHT_FAILED");
    }
    return this.result(
      safeCodes.length === 0 ? "ready" : "blocked",
      safeCodes.length === 0 ? ["CANARY_READ_ONLY_PREFLIGHT_READY"] : safeCodes,
      accountVerified,
      regionVerified,
      ecrRepositoryVerified,
      ecsFoundationVerified,
      loadBalancerVerified,
      identityTagsVerified,
      futureMutationPermissionsVerified,
    );
  }

  private scope(): CanaryScope | null {
    const projectId = this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
    const region = this.config.get<unknown>("AWS_REGION");
    const repository = this.config.get<unknown>("TWO_LANE_CANARY_ECR_REPOSITORY");
    const cluster = this.config.get<unknown>("TWO_LANE_CANARY_ECS_CLUSTER");
    const service = this.config.get<unknown>("TWO_LANE_CANARY_ECS_SERVICE");
    const targetGroup = this.config.get<unknown>("TWO_LANE_CANARY_TARGET_GROUP");
    const iamPrincipalArn = this.config.get<unknown>("TWO_LANE_CANARY_IAM_PRINCIPAL_ARN");
    if (
      typeof projectId !== "string" || !UUID.test(projectId)
      || typeof region !== "string" || !REGION.test(region)
      || [repository, cluster, service, targetGroup].some((value) => typeof value !== "string" || !SAFE_IDENTIFIER.test(value))
      || (iamPrincipalArn !== undefined && iamPrincipalArn !== "" && (typeof iamPrincipalArn !== "string" || !IAM_PRINCIPAL.test(iamPrincipalArn)))
    ) return null;
    return { projectId, environmentName: "dev", region, repository: repository as string, cluster: cluster as string, service: service as string, targetGroup: targetGroup as string, iamPrincipalArn: typeof iamPrincipalArn === "string" && iamPrincipalArn ? iamPrincipalArn : null };
  }

  private async loadManifestPair(projectId: string) {
    const release = await this.dataSource.getRepository(ReleaseManifest).findOne({
      where: { projectId, environmentName: "dev", status: "stable" },
      order: { revision: "DESC" },
    });
    if (!release) return null;
    const infrastructure = await this.dataSource.getRepository(InfrastructureManifest).findOneBy({
      id: release.infrastructureManifestId,
      projectId,
      environmentName: "dev",
    });
    if (!infrastructure || !["applied", "superseded"].includes(infrastructure.status)) {
      return null;
    }
    return { infrastructure, release };
  }

  private async matchesExactIdentityTags(tags: readonly { key?: string; value?: string }[], infrastructure: InfrastructureManifest, release: ReleaseManifest) {
    const values = new Map(tags.map((tag) => [tag.key, tag.value]));
    const releaseIdentityMatches =
      values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.projectId) === release.projectId
      && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.environmentName) === "dev"
      && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId) === release.id
      && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision) === release.revision;
    if (!releaseIdentityMatches) return false;

    const exactInfrastructure =
      values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId) === infrastructure.id
      && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision) === infrastructure.revision;
    let preservedParentInfrastructure = false;
    if (
      infrastructure.parentManifestId
      && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId)
        === infrastructure.parentManifestId
    ) {
      const parent = await this.dataSource.getRepository(InfrastructureManifest)
        .findOneBy({
          id: infrastructure.parentManifestId,
          projectId: release.projectId,
          environmentName: "dev",
          status: "superseded",
        });
      preservedParentInfrastructure = Boolean(
        parent
        && values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision)
          === parent.revision,
      );
    }
    if (!exactInfrastructure && !preservedParentInfrastructure) return false;

    if (values.get(V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash)
      === release.taskDefinitionInputHash) return true;
    if (!release.createdByIntentId) return false;
    const correction = await this.dataSource.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM deployment_side_effects
            WHERE intent_id = $1 AND status = 'succeeded'
              AND effect_type IN (
                'ecs.register_task_definition_command_correction',
                'ecs.register_task_definition_database_binding_correction'
              )
         ) AS registration,
         EXISTS (
           SELECT 1 FROM deployment_side_effects
            WHERE intent_id = $1 AND status = 'succeeded'
              AND effect_type IN (
                'ecs.update_existing_service_command_correction',
                'ecs.update_existing_service_database_binding_correction'
              )
         ) AS service_update`,
      [release.createdByIntentId],
    ) as Array<{ registration: boolean; service_update: boolean }>;
    return correction.length === 1
      && correction[0].registration === true
      && correction[0].service_update === true;
  }

  private async verifyPermissions(scope: CanaryScope) {
    if (!scope.iamPrincipalArn) return false;
    try {
      const { stdout } = await execFile("aws", [
        "iam", "simulate-principal-policy", "--policy-source-arn", scope.iamPrincipalArn,
        "--action-names", "ecs:RegisterTaskDefinition", "ecs:UpdateService", "iam:PassRole",
        "--output", "json", "--no-cli-pager", "--region", scope.region,
      ], { timeout: 10_000, maxBuffer: 64 * 1024 });
      const parsed = JSON.parse(stdout) as { EvaluationResults?: Array<{ EvalDecision?: string }> };
      return Array.isArray(parsed.EvaluationResults)
        && parsed.EvaluationResults.length === 3
        && parsed.EvaluationResults.every((entry) => entry.EvalDecision === "allowed");
    } catch {
      return false;
    }
  }

  private result(
    state: ProductionCanaryPreflightResult["state"],
    safeCodes: readonly string[],
    accountVerified = false,
    regionVerified = false,
    ecrRepositoryVerified = false,
    ecsFoundationVerified = false,
    loadBalancerVerified = false,
    identityTagsVerified = false,
    futureMutationPermissionsVerified = false,
  ): ProductionCanaryPreflightResult {
    return Object.freeze({ state, safeCodes: Object.freeze([...new Set(safeCodes)].sort()), accountVerified, regionVerified, ecrRepositoryVerified, ecsFoundationVerified, loadBalancerVerified, identityTagsVerified, futureMutationPermissionsVerified });
  }
}
