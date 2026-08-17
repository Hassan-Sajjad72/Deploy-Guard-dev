import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import type {
  DescribeServicesCommandOutput,
  DescribeTaskDefinitionCommandOutput,
  DescribeTasksCommandOutput,
  ListTasksCommandOutput,
  Task,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type {
  DescribeTargetGroupsCommandOutput,
  DescribeTargetHealthCommandOutput,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1_ECS_RELEASE_EVIDENCE_TAGS,
} from "./disabled-v1-ecs-read-only-evidence.client";
import {
  buildV1EcsReleaseMutationPlan,
} from "./inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseManifestPair,
  V1EcsReleaseMutationPlan,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1DisabledEcsRolloutHealthVerifierOptions,
  V1EcsRolloutHealthSafeCode,
  V1EcsRolloutHealthVerificationError,
  V1EcsRolloutHealthVerificationInput,
  V1EcsRolloutHealthVerificationResult,
  V1InjectedEcsRolloutReadClient,
  V1InjectedElbv2HealthReadClient,
} from "./inactive-v1-ecs-rollout-health.types";

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const TASK_DEFINITION_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):([0-9]{12}):task-definition\/([A-Za-z0-9_-]{1,255}):([1-9][0-9]*)$/;
const TASK_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):([0-9]{12}):task\/[A-Za-z0-9_.\/-]+$/;
const TARGET_GROUP_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):elasticloadbalancing:([a-z0-9-]+):([0-9]{12}):targetgroup\/[A-Za-z0-9_.-]+\/[A-Za-z0-9]+$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9+/=_:.-]{1,4096}$/;

type EvidenceErrorCode =
  | "ECS_EVIDENCE_AMBIGUOUS"
  | "ECS_ROLLOUT_FAILED"
  | "ECS_TASK_START_FAILED"
  | "ALB_TARGET_UNHEALTHY";

class EcsRolloutEvidenceError extends Error {
  constructor(readonly code: EvidenceErrorCode) {
    super(code);
    this.name = "EcsRolloutEvidenceError";
  }
}

type CandidateDeployment = {
  rolloutState: "COMPLETED" | "IN_PROGRESS" | "FAILED";
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
};

type CandidateTask = {
  arnHash: string;
  privateIpv4Address: string;
};

type SanitizedEvidence = {
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  taskDefinitionArnHash: string;
  clusterArnHash: string;
  serviceArnHash: string;
  targetGroupArnHash: string;
  rolloutState: CandidateDeployment["rolloutState"];
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  candidateTaskHashes: string[];
  stoppedCandidateTaskHashes: string[];
  candidateTargetStates: string[];
};

export class DisabledV1EcsRolloutHealthVerifier {
  readonly policy =
    "deployguard.ecs-rollout-health/disabled-read-only-v1" as const;

  private readonly maxTaskPages: number;
  private readonly taskPageSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly ecs: V1InjectedEcsRolloutReadClient,
    private readonly elbv2: V1InjectedElbv2HealthReadClient,
    private readonly options: V1DisabledEcsRolloutHealthVerifierOptions,
  ) {
    this.maxTaskPages = options?.maxTaskPages ?? 5;
    this.taskPageSize = options?.taskPageSize ?? 100;
    this.now = options?.now ?? (() => new Date());
    if (
      !ecs
      || typeof ecs.send !== "function"
      || !elbv2
      || typeof elbv2.send !== "function"
      || !REGION.test(options?.region)
      || !Number.isInteger(this.maxTaskPages)
      || this.maxTaskPages < 1
      || this.maxTaskPages > 20
      || !Number.isInteger(this.taskPageSize)
      || this.taskPageSize < 1
      || this.taskPageSize > 100
      || typeof this.now !== "function"
    ) {
      throw new V1EcsRolloutHealthVerificationError(
        "ECS_ROLLOUT_HEALTH_CONTRACT_INVALID",
      );
    }
  }

  async verify(
    input: V1EcsRolloutHealthVerificationInput,
  ): Promise<V1EcsRolloutHealthVerificationResult> {
    this.assertInput(input);
    this.assertTrusted(input);
    let evidence: SanitizedEvidence | null = null;
    try {
      const pair = await input.manifests.loadExact(input.revision);
      this.assertTrusted(input);
      if (!pair) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      const plan = buildV1EcsReleaseMutationPlan(input.revision, pair);
      const identities = this.exactIdentities(pair, plan);

      await this.verifyTaskDefinition(
        input,
        pair,
        plan,
        identities.taskDefinitionArn,
      );
      const deployment = await this.readCandidateDeployment(
        input,
        identities.clusterArn,
        identities.serviceArn,
        identities.taskDefinitionArn,
      );
      const runningArns = await this.listTasks(
        input,
        identities.clusterArn,
        identities.serviceArn,
        "RUNNING",
      );
      const stoppedArns = await this.listTasks(
        input,
        identities.clusterArn,
        identities.serviceArn,
        "STOPPED",
      );
      const running = await this.describeTasks(
        input,
        identities.clusterArn,
        runningArns,
      );
      const stopped = await this.describeTasks(
        input,
        identities.clusterArn,
        stoppedArns,
      );
      const candidateTasks = this.candidateRunningTasks(
        running,
        identities.taskDefinitionArn,
        this.serviceName(identities.serviceArn),
        plan.registerTaskDefinition.containerName,
      );
      const stoppedCandidateTaskHashes = this.stoppedCandidateTasks(
        stopped,
        identities.taskDefinitionArn,
        this.serviceName(identities.serviceArn),
      );
      if (candidateTasks.length !== deployment.runningCount) {
        throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      }
      await this.verifyTargetGroup(
        input,
        identities.targetGroupArn,
        plan.registerTaskDefinition.containerPort,
      );
      const targetStates = await this.readCandidateTargetStates(
        input,
        identities.targetGroupArn,
        candidateTasks,
        plan.registerTaskDefinition.containerPort,
      );
      evidence = {
        releaseManifestId: pair.release.id,
        releaseRevision: pair.release.revision,
        infrastructureManifestId: pair.infrastructure.id,
        infrastructureRevision: pair.infrastructure.revision,
        taskDefinitionInputHash: plan.taskDefinitionInputHash,
        taskDefinitionArnHash: canonicalSha256(
          identities.taskDefinitionArn,
        ),
        clusterArnHash: canonicalSha256(identities.clusterArn),
        serviceArnHash: canonicalSha256(identities.serviceArn),
        targetGroupArnHash: canonicalSha256(identities.targetGroupArn),
        rolloutState: deployment.rolloutState,
        desiredCount: deployment.desiredCount,
        runningCount: deployment.runningCount,
        pendingCount: deployment.pendingCount,
        candidateTaskHashes: candidateTasks.map((item) => item.arnHash).sort(),
        stoppedCandidateTaskHashes: stoppedCandidateTaskHashes.sort(),
        candidateTargetStates: [...targetStates].sort(),
      };
      return this.classify(input, deployment, candidateTasks, targetStates,
        stoppedCandidateTaskHashes, evidence);
    } catch (error) {
      if (error instanceof V1EcsRolloutHealthVerificationError) throw error;
      const code = error instanceof EcsRolloutEvidenceError
        ? error.code
        : "ECS_EVIDENCE_AMBIGUOUS";
      const safeCode: V1EcsRolloutHealthSafeCode =
        code === "ECS_ROLLOUT_FAILED"
          ? "ECS_ROLLOUT_FAILED"
          : code === "ECS_TASK_START_FAILED"
          ? "ECS_TASK_START_FAILED"
          : code === "ALB_TARGET_UNHEALTHY"
          ? "ALB_TARGET_UNHEALTHY"
          : "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS";
      return {
        status: safeCode === "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS"
          ? "ambiguous"
          : "failed",
        safeCode,
        evidenceHash: canonicalSha256({
          schemaVersion: 1,
          safeCode,
          evidence,
        }),
      };
    }
  }

  private exactIdentities(
    pair: V1EcsReleaseManifestPair,
    plan: V1EcsReleaseMutationPlan,
  ) {
    const taskDefinitionArn = pair.release.taskDefinitionArn;
    const outputs = pair.infrastructure.terraformOutputs;
    const targetGroupArn = outputs.alb_target_group_arn;
    const outputPort = outputs.ecs_container_port;
    if (
      pair.release.taskDefinitionInputHash !== plan.taskDefinitionInputHash
      || typeof taskDefinitionArn !== "string"
      || !TASK_DEFINITION_ARN.test(taskDefinitionArn)
      || typeof targetGroupArn !== "string"
      || !TARGET_GROUP_ARN.test(targetGroupArn)
      || (
        outputPort !== undefined
        && outputPort !== plan.registerTaskDefinition.containerPort
      )
      || !this.sameAwsIdentity(
        taskDefinitionArn,
        plan.updateService.clusterArn,
        plan.updateService.serviceArn,
        targetGroupArn,
      )
    ) {
      throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    }
    return {
      taskDefinitionArn,
      targetGroupArn,
      clusterArn: plan.updateService.clusterArn,
      serviceArn: plan.updateService.serviceArn,
    };
  }

  private async verifyTaskDefinition(
    input: V1EcsRolloutHealthVerificationInput,
    pair: V1EcsReleaseManifestPair,
    plan: V1EcsReleaseMutationPlan,
    taskDefinitionArn: string,
  ) {
    const response = await this.ecsRead<DescribeTaskDefinitionCommandOutput>(
      input,
      new DescribeTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn,
        include: ["TAGS"],
      }),
    );
    const task = response.taskDefinition;
    const matching = task?.containerDefinitions?.filter((item) =>
      item.name === plan.registerTaskDefinition.containerName
    ) ?? [];
    const tags = new Map<string, string>();
    for (const tag of response.tags ?? []) {
      if (
        typeof tag.key !== "string"
        || typeof tag.value !== "string"
        || tags.has(tag.key)
      ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      tags.set(tag.key, tag.value);
    }
    const expectedTags = plan.registerTaskDefinition.evidenceTags;
    if (
      !task
      || task.taskDefinitionArn !== taskDefinitionArn
      || task.status !== "ACTIVE"
      || task.family !== plan.registerTaskDefinition.family
      || matching.length !== 1
      || matching[0].image !== plan.registerTaskDefinition.immutableImage
      || (matching[0].portMappings ?? []).filter((mapping) =>
        mapping.containerPort === plan.registerTaskDefinition.containerPort
      ).length !== 1
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.projectId)
        !== pair.release.projectId
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.environmentName)
        !== pair.release.environmentName
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId)
        !== pair.release.id
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision)
        !== pair.release.revision
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId)
        !== pair.infrastructure.id
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision)
        !== pair.infrastructure.revision
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash)
        !== expectedTags.taskDefinitionInputHash
      || tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.imageDigest)
        !== expectedTags.imageDigest
    ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
  }

  private async readCandidateDeployment(
    input: V1EcsRolloutHealthVerificationInput,
    clusterArn: string,
    serviceArn: string,
    taskDefinitionArn: string,
  ): Promise<CandidateDeployment> {
    const response = await this.ecsRead<DescribeServicesCommandOutput>(
      input,
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: [serviceArn],
      }),
    );
    if ((response.failures?.length ?? 0) > 0) {
      throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    }
    const services = response.services ?? [];
    if (
      services.length !== 1
      || services[0].clusterArn !== clusterArn
      || services[0].serviceArn !== serviceArn
      || services[0].status !== "ACTIVE"
      || !Array.isArray(services[0].deployments)
    ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    const matching = services[0].deployments!.filter((deployment) =>
      deployment.taskDefinition === taskDefinitionArn
    );
    if (matching.length !== 1 || matching[0].status !== "PRIMARY") {
      throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    }
    const deployment = matching[0];
    // ECS can expose the exact new PRIMARY deployment before the service's
    // top-level taskDefinition projection converges. That bounded state is
    // progressing, not conflicting evidence. A completed deployment must
    // still agree with the top-level service identity.
    if (
      services[0].taskDefinition !== taskDefinitionArn
      && deployment.rolloutState !== "IN_PROGRESS"
    ) {
      throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    }
    if (deployment.rolloutState === "FAILED") {
      throw new EcsRolloutEvidenceError("ECS_ROLLOUT_FAILED");
    }
    if (
      (
        deployment.rolloutState !== "COMPLETED"
        && deployment.rolloutState !== "IN_PROGRESS"
      )
      || !this.nonNegativeInteger(deployment.desiredCount)
      || deployment.desiredCount! < 1
      || !this.nonNegativeInteger(deployment.runningCount)
      || !this.nonNegativeInteger(deployment.pendingCount)
      || deployment.runningCount! > deployment.desiredCount!
      || deployment.pendingCount! > deployment.desiredCount!
    ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    return {
      rolloutState: deployment.rolloutState,
      desiredCount: deployment.desiredCount!,
      runningCount: deployment.runningCount!,
      pendingCount: deployment.pendingCount!,
    };
  }

  private async listTasks(
    input: V1EcsRolloutHealthVerificationInput,
    clusterArn: string,
    serviceArn: string,
    desiredStatus: "RUNNING" | "STOPPED",
  ) {
    const arns: string[] = [];
    const tokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < this.maxTaskPages; page += 1) {
      const response = await this.ecsRead<ListTasksCommandOutput>(
        input,
        new ListTasksCommand({
          cluster: clusterArn,
          serviceName: serviceArn,
          desiredStatus,
          maxResults: this.taskPageSize,
          nextToken,
        }),
      );
      const pageArns = response.taskArns ?? [];
      if (
        !Array.isArray(pageArns)
        || pageArns.some((arn) =>
          typeof arn !== "string" || !TASK_ARN.test(arn)
        )
      ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      arns.push(...pageArns);
      nextToken = response.nextToken;
      if (nextToken === undefined) {
        if (new Set(arns).size !== arns.length) {
          throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
        }
        return arns;
      }
      if (!OPAQUE_TOKEN.test(nextToken) || tokens.has(nextToken)) {
        throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      }
      tokens.add(nextToken);
    }
    throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
  }

  private async describeTasks(
    input: V1EcsRolloutHealthVerificationInput,
    clusterArn: string,
    arns: string[],
  ) {
    const result: Task[] = [];
    for (let offset = 0; offset < arns.length; offset += 100) {
      const batch = arns.slice(offset, offset + 100);
      const response = await this.ecsRead<DescribeTasksCommandOutput>(
        input,
        new DescribeTasksCommand({
          cluster: clusterArn,
          tasks: batch,
        }),
      );
      if ((response.failures?.length ?? 0) > 0) {
        throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      }
      const tasks = response.tasks ?? [];
      if (
        tasks.length !== batch.length
        || tasks.some((task) =>
          typeof task.taskArn !== "string"
          || !batch.includes(task.taskArn)
          || task.clusterArn !== clusterArn
        )
      ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      result.push(...tasks);
    }
    return result;
  }

  private candidateRunningTasks(
    tasks: Task[],
    taskDefinitionArn: string,
    serviceName: string,
    containerName: string,
  ): CandidateTask[] {
    return tasks
      .filter((task) =>
        task.taskDefinitionArn === taskDefinitionArn
        && task.group === `service:${serviceName}`
      )
      .map((task) => {
        const containers = task.containers?.filter((container) =>
          container.name === containerName
        ) ?? [];
        const networks = containers[0]?.networkInterfaces ?? [];
        if (
          task.lastStatus !== "RUNNING"
          || task.desiredStatus !== "RUNNING"
          || containers.length !== 1
          || containers[0].lastStatus !== "RUNNING"
          || networks.length !== 1
          || !IPV4.test(networks[0].privateIpv4Address ?? "")
        ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
        return {
          arnHash: canonicalSha256(task.taskArn!),
          privateIpv4Address: networks[0].privateIpv4Address!,
        };
      });
  }

  private stoppedCandidateTasks(
    tasks: Task[],
    taskDefinitionArn: string,
    serviceName: string,
  ) {
    const stopped = tasks.filter((task) =>
      task.taskDefinitionArn === taskDefinitionArn
      && task.group === `service:${serviceName}`
    );
    return stopped.flatMap((task) => {
      const failed = task.stopCode === "TaskFailedToStart"
        || task.stopCode === "EssentialContainerExited"
        || (task.containers ?? []).some((container) =>
          typeof container.exitCode === "number" && container.exitCode !== 0
        )
        || this.isKnownTaskFailureReason(task.stoppedReason)
        || (task.containers ?? []).some((container) =>
          this.isKnownTaskFailureReason(container.reason)
        );
      return failed ? [canonicalSha256(task.taskArn!)] : [];
    });
  }

  private async verifyTargetGroup(
    input: V1EcsRolloutHealthVerificationInput,
    targetGroupArn: string,
    port: number,
  ) {
    const response =
      await this.elbv2Read<DescribeTargetGroupsCommandOutput>(
        input,
        new DescribeTargetGroupsCommand({
          TargetGroupArns: [targetGroupArn],
        }),
      );
    const groups = response.TargetGroups ?? [];
    if (
      groups.length !== 1
      || groups[0].TargetGroupArn !== targetGroupArn
      || groups[0].Port !== port
      || groups[0].TargetType !== "ip"
      || (
        groups[0].Protocol !== "HTTP"
        && groups[0].Protocol !== "HTTPS"
      )
    ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
  }

  private async readCandidateTargetStates(
    input: V1EcsRolloutHealthVerificationInput,
    targetGroupArn: string,
    tasks: CandidateTask[],
    port: number,
  ) {
    const response =
      await this.elbv2Read<DescribeTargetHealthCommandOutput>(
        input,
        new DescribeTargetHealthCommand({
          TargetGroupArn: targetGroupArn,
        }),
      );
    const descriptions = response.TargetHealthDescriptions ?? [];
    const targets = new Map<string, string>();
    for (const description of descriptions) {
      const id = description.Target?.Id;
      const targetPort = description.Target?.Port;
      const state = description.TargetHealth?.State;
      const key = `${id}:${targetPort}`;
      if (
        typeof id !== "string"
        || !IPV4.test(id)
        || targetPort !== port
        || (
          state !== "healthy"
          && state !== "initial"
          && state !== "unhealthy"
          && state !== "unused"
          && state !== "draining"
          && state !== "unavailable"
        )
        || targets.has(key)
      ) throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
      targets.set(key, state);
    }
    return tasks.map((task) =>
      targets.get(`${task.privateIpv4Address}:${port}`) ?? "missing"
    );
  }

  private classify(
    input: V1EcsRolloutHealthVerificationInput,
    deployment: CandidateDeployment,
    candidateTasks: CandidateTask[],
    targetStates: string[],
    stoppedCandidateTaskHashes: string[],
    evidence: SanitizedEvidence,
  ): V1EcsRolloutHealthVerificationResult {
    const complete = deployment.rolloutState === "COMPLETED"
      && deployment.pendingCount === 0
      && deployment.runningCount === deployment.desiredCount
      && candidateTasks.length === deployment.desiredCount;
    const allTargetsHealthy = targetStates.length === deployment.desiredCount
      && targetStates.every((state) => state === "healthy");
    if (complete && allTargetsHealthy) {
      return this.result(
        "healthy",
        "ECS_ROLLOUT_AND_TARGETS_HEALTHY",
        evidence,
      );
    }
    if (
      targetStates.some((state) => state === "unhealthy" || state === "unused")
    ) {
      throw new EcsRolloutEvidenceError("ALB_TARGET_UNHEALTHY");
    }
    if (targetStates.some((state) => state === "unavailable")) {
      throw new EcsRolloutEvidenceError("ECS_EVIDENCE_AMBIGUOUS");
    }
    if (
      stoppedCandidateTaskHashes.length > 0
      && candidateTasks.length < deployment.desiredCount
    ) {
      throw new EcsRolloutEvidenceError("ECS_TASK_START_FAILED");
    }
    if (this.now().getTime() >= input.deadlineAt.getTime()) {
      return this.result(
        "timed_out",
        "ECS_ROLLOUT_HEALTH_TIMEOUT",
        evidence,
      );
    }
    return this.result(
      "progressing",
      deployment.rolloutState === "COMPLETED"
        ? "ECS_TARGETS_REGISTERING"
        : "ECS_ROLLOUT_PROGRESSING",
      evidence,
    );
  }

  private result(
    status: V1EcsRolloutHealthVerificationResult["status"],
    safeCode: V1EcsRolloutHealthSafeCode,
    evidence: SanitizedEvidence,
  ) {
    return {
      status,
      safeCode,
      evidenceHash: canonicalSha256({
        schemaVersion: 1,
        safeCode,
        evidence,
      }),
    };
  }

  private async ecsRead<T>(
    input: V1EcsRolloutHealthVerificationInput,
    command: Parameters<V1InjectedEcsRolloutReadClient["send"]>[0],
  ): Promise<T> {
    this.assertTrusted(input);
    const response = await this.ecs.send(command, {
      abortSignal: input.execution.signal,
    });
    this.assertTrusted(input);
    return response as T;
  }

  private async elbv2Read<T>(
    input: V1EcsRolloutHealthVerificationInput,
    command: Parameters<V1InjectedElbv2HealthReadClient["send"]>[0],
  ): Promise<T> {
    this.assertTrusted(input);
    const response = await this.elbv2.send(command, {
      abortSignal: input.execution.signal,
    });
    this.assertTrusted(input);
    return response as T;
  }

  private assertInput(input: V1EcsRolloutHealthVerificationInput) {
    const deadline = input?.deadlineAt;
    const now = this.now();
    if (
      !input
      || !input.manifests
      || typeof input.manifests.loadExact !== "function"
      || !input.execution
      || !input.execution.signal
      || typeof input.execution.isLeaseTrusted !== "function"
      || !(deadline instanceof Date)
      || !Number.isFinite(deadline.getTime())
      || !(now instanceof Date)
      || !Number.isFinite(now.getTime())
    ) {
      throw new V1EcsRolloutHealthVerificationError(
        "ECS_ROLLOUT_HEALTH_CONTRACT_INVALID",
      );
    }
  }

  private assertTrusted(input: V1EcsRolloutHealthVerificationInput) {
    if (input.execution.signal.aborted) {
      throw new V1EcsRolloutHealthVerificationError(
        "ECS_ROLLOUT_HEALTH_CANCELLED",
      );
    }
    if (!input.execution.isLeaseTrusted()) {
      throw new V1EcsRolloutHealthVerificationError(
        "ECS_ROLLOUT_HEALTH_OWNERSHIP_LOST",
      );
    }
  }

  private sameAwsIdentity(...arns: string[]) {
    const identities = arns.map((arn) => {
      const parts = arn.split(":");
      return `${parts[1]}:${parts[3]}:${parts[4]}`;
    });
    return identities.every((identity) => identity === identities[0])
      && arns[0].split(":")[3] === this.options.region;
  }

  private serviceName(serviceArn: string) {
    return serviceArn.split("/").at(-1)!;
  }

  private isKnownTaskFailureReason(reason: unknown) {
    return typeof reason === "string"
      && /CannotPullContainer|ResourceInitializationError|CannotCreateContainer|OutOfMemory|Essential container|health check failed/i
        .test(reason);
  }

  private nonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
  }
}
