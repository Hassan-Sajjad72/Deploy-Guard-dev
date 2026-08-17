import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  ProjectSecurityScan,
  SecurityPolicyDecision,
  SecurityScanStatus,
} from "../../projects/project-security-scan.entity";
import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1FirstReleaseBootstrapClient,
  V1FirstReleaseImageBuildRequest,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseServiceRequest,
  V1FirstReleaseTaskDefinitionRequest,
} from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import {
  V1HandlerSideEffectExecutorContext,
} from "../worker-runtime/v1-handler-side-effect.types";
import {
  V1ReleaseLaneFixtureAdapters,
  V1ReleaseLaneGateConfiguration,
} from "./inactive-v1-release-lane-composition";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ECR_REPOSITORY =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*$/;
const ECS_SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;

/**
 * Deterministic external-boundary substitute for local PostgreSQL/Redis
 * integration tests. The provider can be present in the application module,
 * but construction fails closed unless the process is explicitly a test
 * process with the dedicated local-fixture gate and one exact project/dev
 * scope. It imports no Docker or AWS clients and performs no I/O.
 */
@Injectable()
export class LocalV1ReleaseFixtureAdapterFactory {
  private client: DeterministicLocalReleaseClient | null = null;
  private configuration: V1ReleaseLaneGateConfiguration | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(ProjectSecurityScan)
    private readonly securityScans?: Repository<ProjectSecurityScan>,
  ) {}

  create(
    configuration: V1ReleaseLaneGateConfiguration,
  ): V1ReleaseLaneFixtureAdapters {
    this.assertEnabled(configuration);
    const client = new DeterministicLocalReleaseClient(
      this.securityScans,
      this.outcomeMode() as "healthy" | "ambiguous_once",
    );
    this.client = client;
    this.configuration = configuration;
    return Object.freeze({
      policy: "deployguard.release-lane/fixture-adapters-v1" as const,
      mutationClient: Object.freeze({
        policy: "deployguard.ecs-release-mutation/client-v1" as const,
        registerTaskDefinitionRevision:
          client.registerTaskDefinitionRevision.bind(client),
        updateExistingService: client.updateExistingService.bind(client),
      }),
      rolloutVerifier: Object.freeze({
        policy:
          "deployguard.ecs-rollout-health/disabled-read-only-v1" as const,
        verify: client.verify.bind(client),
      }),
      readOnlyEvidenceClient: Object.freeze({
        policy:
          "deployguard.ecs-release-reconciliation/fixture-read-only-v1" as const,
        findTaskDefinitionEvidence:
          client.findTaskDefinitionEvidence.bind(client),
        findServiceUpdateEvidence:
          client.findServiceUpdateEvidence.bind(client),
      }),
      firstReleaseClient: Object.freeze({
        policy: "deployguard.first-release-bootstrap/client-v1" as const,
        buildAndPushImmutableImage:
          client.buildAndPushImmutableImage.bind(client),
        resolveImmutableImageEvidence:
          client.resolveImmutableImageEvidence.bind(client),
        inspectExactService: client.inspectExactService.bind(client),
        registerInitialTaskDefinition:
          client.registerInitialTaskDefinition.bind(client),
        createInitialService: client.createInitialService.bind(client),
        verifyInitialRelease: client.verifyInitialRelease.bind(client),
      }),
    });
  }

  /**
   * Process-local read-only evidence for the explicit ambiguous-once fixture.
   * `null` means the fixture contract is not active, so production keeps using
   * its AWS reader. No durable or external state is changed here.
   */
  inspectConvergence(input: {
    projectId: string;
    candidateDigest: string;
    candidateTaskDefinitionArn: string;
    serviceArn: string;
    ecrRepositoryName: string;
  }): boolean | null {
    if (
      this.outcomeMode() !== "ambiguous_once"
      || !this.client
      || !this.configuration
      || this.configuration.projectAllowlist.length !== 1
      || this.configuration.projectAllowlist[0] !== input.projectId
      || this.configuration.environmentAllowlist.length !== 1
      || this.configuration.environmentAllowlist[0] !== "dev"
      || this.config.get<unknown>("NODE_ENV") !== "test"
      || this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE")
        !== "fixture"
      || this.config.get<unknown>(
        "TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED",
      ) !== "true"
    ) return null;
    return this.client.inspectConvergence(input);
  }

  private assertEnabled(configuration: V1ReleaseLaneGateConfiguration) {
    if (
      this.config.get<unknown>("NODE_ENV") !== "test"
      || this.config.get<unknown>(
        "TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED",
      ) !== "true"
      || this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE")
        !== "fixture"
      || configuration.projectAllowlist.length !== 1
      || !UUID.test(configuration.projectAllowlist[0])
      || configuration.environmentAllowlist.length !== 1
      || configuration.environmentAllowlist[0] !== "dev"
      || !["healthy", "ambiguous_once"].includes(this.outcomeMode())
    ) {
      throw new Error("LOCAL_RELEASE_FIXTURE_CONFIGURATION_INVALID");
    }
  }

  private outcomeMode() {
    return this.config.get<string>(
      "TWO_LANE_LOCAL_RELEASE_FIXTURE_OUTCOME",
      "healthy",
    );
  }
}

class DeterministicLocalReleaseClient {
  private image: {
    projectId: string;
    repositoryUrl: string;
    digest: string;
  } | null = null;
  private taskDefinitionArn: string | null = null;
  private serviceArn: string | null = null;
  private ambiguousVerificationObserved = false;

  constructor(
    private readonly securityScans?: Repository<ProjectSecurityScan>,
    private readonly outcomeMode: "healthy" | "ambiguous_once" = "healthy",
  ) {}

  async buildAndPushImmutableImage(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence> {
    this.assertOwnership(ownership);
    if (!ECR_REPOSITORY.test(input.repositoryUrl)) {
      throw new Error("LOCAL_RELEASE_FIXTURE_CONTRACT_INVALID");
    }
    const imageDigest = `sha256:${canonicalSha256({
      schemaVersion: 1,
      fixture: "normal-v1-local-release",
      projectId: input.projectId,
      commitSha: input.commitSha,
      buildFingerprint: input.buildFingerprint,
      repositoryUrl: input.repositoryUrl,
    })}`;
    const evidence = Object.freeze({
      imageUri: `${input.repositoryUrl}@${imageDigest}`,
      imageDigest,
      commitSha: input.commitSha,
      buildFingerprint: input.buildFingerprint,
    });
    this.image = {
      projectId: input.projectId,
      repositoryUrl: input.repositoryUrl,
      digest: imageDigest,
    };
    await this.recordAllowedSecurityEvidence(input, evidence.imageUri);
    return evidence;
  }

  resolveImmutableImageEvidence(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    return this.buildAndPushImmutableImage(input, ownership);
  }

  async inspectExactService(
    _input: {
      clusterArn: string;
      serviceName: string;
      infrastructureManifestId: string;
      infrastructureRevision: string;
    },
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    return Object.freeze({ state: "absent" as const });
  }

  async registerInitialTaskDefinition(
    input: V1FirstReleaseTaskDefinitionRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    return Object.freeze({
      taskDefinitionArn:
        `arn:aws:ecs:${input.region}:000000000000:task-definition/${input.family}:1`,
    });
  }

  async createInitialService(
    input: V1FirstReleaseServiceRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    const clusterName = input.clusterArn.split("/").at(-1);
    if (!clusterName) {
      throw new Error("LOCAL_RELEASE_FIXTURE_CONTRACT_INVALID");
    }
    return Object.freeze({
      serviceArn:
        `arn:aws:ecs:${input.region}:000000000000:service/${clusterName}/${input.serviceName}`,
    });
  }

  async verifyInitialRelease(
    input: Parameters<V1FirstReleaseBootstrapClient["verifyInitialRelease"]>[0],
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    return Object.freeze({
      safeCode: "FIRST_RELEASE_HEALTHY" as const,
      evidenceHash: canonicalSha256({
        schemaVersion: 1,
        fixture: "normal-v1-local-first-release-health",
        serviceArn: input.serviceArn,
        taskDefinitionArn: input.taskDefinitionArn,
      }),
      applicationUrl: "https://local-release-fixture.invalid",
    });
  }

  async registerTaskDefinitionRevision(
    request: Parameters<
      V1ReleaseLaneFixtureAdapters["mutationClient"]["registerTaskDefinitionRevision"]
    >[0],
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    this.taskDefinitionArn =
      `arn:aws:ecs:${request.region}:000000000000:task-definition/${request.family}:1`;
    return Object.freeze({ taskDefinitionArn: this.taskDefinitionArn });
  }

  async updateExistingService(
    request: Parameters<
      V1ReleaseLaneFixtureAdapters["mutationClient"]["updateExistingService"]
    >[0],
    ownership: V1HandlerSideEffectExecutorContext,
  ) {
    this.assertOwnership(ownership);
    if (!ECS_SERVICE_ARN.test(request.serviceArn)) {
      throw new Error("LOCAL_RELEASE_FIXTURE_CONTRACT_INVALID");
    }
    this.serviceArn = request.serviceArn;
    return Object.freeze({ serviceArn: request.serviceArn });
  }

  async verify(
    input: Parameters<V1ReleaseLaneFixtureAdapters["rolloutVerifier"]["verify"]>[0],
  ) {
    if (
      input.execution.signal.aborted
      || !input.execution.isLeaseTrusted()
    ) {
      throw new Error("LOCAL_RELEASE_FIXTURE_OWNERSHIP_LOST");
    }
    if (
      this.outcomeMode === "ambiguous_once"
      && !this.ambiguousVerificationObserved
    ) {
      this.ambiguousVerificationObserved = true;
      return Object.freeze({
        status: "ambiguous" as const,
        safeCode: "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS" as const,
        evidenceHash: canonicalSha256({
          schemaVersion: 1,
          fixture: "normal-v1-local-release-health-ambiguous",
          revision: input.revision,
        }),
      });
    }
    return Object.freeze({
      status: "healthy" as const,
      safeCode: "ECS_ROLLOUT_AND_TARGETS_HEALTHY" as const,
      evidenceHash: canonicalSha256({
        schemaVersion: 1,
        fixture: "normal-v1-local-release-health",
        revision: input.revision,
      }),
    });
  }

  inspectConvergence(input: {
    projectId: string;
    candidateDigest: string;
    candidateTaskDefinitionArn: string;
    serviceArn: string;
    ecrRepositoryName: string;
  }) {
    return this.ambiguousVerificationObserved
      && this.image?.projectId === input.projectId
      && this.image.digest === input.candidateDigest
      && this.image.repositoryUrl.endsWith(`/${input.ecrRepositoryName}`)
      && this.taskDefinitionArn === input.candidateTaskDefinitionArn
      && this.serviceArn === input.serviceArn;
  }

  async findTaskDefinitionEvidence() {
    return Object.freeze([]) as readonly never[];
  }

  async findServiceUpdateEvidence() {
    return Object.freeze([]) as readonly never[];
  }

  private assertOwnership(ownership: V1HandlerSideEffectExecutorContext) {
    if (ownership.signal.aborted || !ownership.isLeaseTrusted()) {
      throw new Error("LOCAL_RELEASE_FIXTURE_OWNERSHIP_LOST");
    }
  }

  private async recordAllowedSecurityEvidence(
    input: V1FirstReleaseImageBuildRequest,
    imageUri: string,
  ) {
    if (!this.securityScans) return;
    const existing = await this.securityScans.findOne({
      where: { projectId: input.projectId, imageUri },
      order: { updatedAt: "DESC" },
    });
    if (existing) return;
    const now = new Date();
    await this.securityScans.save(this.securityScans.create({
      projectId: input.projectId,
      pipelineRunId: null,
      imageName: input.repositoryUrl,
      imageTag: null,
      imageUri,
      scanner: "deployguard-local-fixture",
      scannerVersion: "1",
      scanStatus: SecurityScanStatus.COMPLETED,
      startedAt: now,
      completedAt: now,
      failedAt: null,
      totalVulnerabilities: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      unknownCount: 0,
      policyDecision: SecurityPolicyDecision.ALLOWED,
      policyReason: "LOCAL_FIXTURE_POLICY_ALLOWED",
      manualApprovalRequired: false,
      approvedByUserId: null,
      approvedAt: null,
      approvalReason: null,
      rawSummary: null,
    }));
  }
}
