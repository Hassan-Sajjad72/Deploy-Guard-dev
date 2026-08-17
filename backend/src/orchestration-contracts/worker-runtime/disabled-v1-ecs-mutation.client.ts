import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import type {
  ContainerDefinition,
  DescribeServicesCommandOutput,
  DescribeTaskDefinitionCommandOutput,
  ECSClient,
  RegisterTaskDefinitionCommandInput,
  RegisterTaskDefinitionCommandOutput,
  Tag,
  UpdateServiceCommandOutput,
} from "@aws-sdk/client-ecs";
import {
  V1_ECS_RELEASE_EVIDENCE_TAGS,
} from "./disabled-v1-ecs-read-only-evidence.client";
import {
  V1EcsEnvironmentReference,
  V1EcsRegisterTaskDefinitionRevisionRequest,
  V1EcsReleaseMutationClient,
  V1EcsServiceBindingReference,
  V1EcsUpdateExistingServiceRequest,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1HandlerSideEffectExecutorContext,
} from "./v1-handler-side-effect.types";

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[1-9][0-9]*$/;
const HASH = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const FAMILY = /^[A-Za-z0-9_-]{1,255}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const LOG_GROUP = /^\/[A-Za-z0-9_./#-]{1,511}$/;
const TASK_DEFINITION_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):([0-9]{12}):task-definition\/([A-Za-z0-9_-]{1,255}):([1-9][0-9]*)$/;
const CLUSTER_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):([0-9]{12}):cluster\/[A-Za-z0-9_.\/-]+$/;
const SERVICE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):([0-9]{12}):service\/[A-Za-z0-9_.\/-]+$/;
const IAM_ROLE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;
const SECRET_VALUE_FROM =
  /^arn:(?:aws|aws-us-gov|aws-cn):(?:secretsmanager|ssm):[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_+=,.@:/-]{1,1024}$/;
const SECRET_LIKE_NAME =
  /(?:^|_)(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|CREDENTIALS?)(?:_|$)/i;

export type V1InjectedEcsMutationClient = Pick<ECSClient, "send">;

export type V1ResolvedEcsEnvironmentValue = {
  name: string;
  value: string;
};

export type V1ResolvedEcsSecretReference = {
  name: string;
  valueFrom: string;
};

export type V1ResolvedEcsRuntimeReferences = {
  environment: readonly V1ResolvedEcsEnvironmentValue[];
  secrets: readonly V1ResolvedEcsSecretReference[];
};

export interface V1EcsRuntimeReferenceResolver {
  readonly policy:
    "deployguard.ecs-release-mutation/runtime-reference-resolver-v1";
  resolve(
    input: {
      environmentReferences: readonly V1EcsEnvironmentReference[];
      serviceBindingReferences: readonly V1EcsServiceBindingReference[];
    },
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1ResolvedEcsRuntimeReferences>;
}

export type V1DisabledEcsMutationClientOptions = {
  region: string;
};

type MutationErrorCode =
  | "ECS_MUTATION_CANCELLED"
  | "ECS_MUTATION_CONTRACT_INVALID"
  | "ECS_MUTATION_IDENTITY_MISMATCH"
  | "ECS_MUTATION_OWNERSHIP_LOST"
  | "ECS_MUTATION_REFERENCE_RESOLUTION_INVALID"
  | "ECS_MUTATION_SOURCE_DEFINITION_INVALID"
  | "ECS_MUTATION_SOURCE_NOT_FOUND"
  | "ECS_MUTATION_RESULT_INVALID"
  | "ECS_MUTATION_RESULT_UNCERTAIN";

export class DisabledV1EcsMutationError extends Error {
  constructor(readonly code: MutationErrorCode) {
    super(code);
    this.name = "DisabledV1EcsMutationError";
  }
}

export class DisabledV1EcsMutationClient
implements V1EcsReleaseMutationClient {
  readonly policy =
    "deployguard.ecs-release-mutation/client-v1" as const;

  constructor(
    private readonly client: V1InjectedEcsMutationClient,
    private readonly references: V1EcsRuntimeReferenceResolver,
    private readonly options: V1DisabledEcsMutationClientOptions,
  ) {
    if (
      !client
      || typeof client.send !== "function"
      || references?.policy
        !== "deployguard.ecs-release-mutation/runtime-reference-resolver-v1"
      || typeof references.resolve !== "function"
      || !REGION.test(options?.region)
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_CONTRACT_INVALID",
      );
    }
  }

  async registerTaskDefinitionRevision(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ taskDefinitionArn: string }> {
    try {
      this.assertRegistrationRequest(request);
      this.assertTrusted(ownership);

      const sourceResponse = await this.client.send(
        new DescribeTaskDefinitionCommand({
          taskDefinition: request.sourceTaskDefinitionArn,
          include: ["TAGS"],
        }),
        { abortSignal: ownership.signal },
      ) as DescribeTaskDefinitionCommandOutput;
      this.assertTrusted(ownership);

      const source = this.validateSourceTaskDefinition(
        request,
        sourceResponse,
      );
      const resolved = await this.references.resolve({
        environmentReferences: request.environmentReferences,
        serviceBindingReferences: request.serviceBindingReferences,
      }, ownership);
      this.assertTrusted(ownership);
      const runtime = this.validateResolvedReferences(request, resolved);
      const registration = this.buildRegistrationRequest(
        request,
        sourceResponse,
        source,
        runtime,
      );
      this.assertTrusted(ownership);

      const response = await this.client.send(
        new RegisterTaskDefinitionCommand(registration),
        { abortSignal: ownership.signal },
      ) as RegisterTaskDefinitionCommandOutput;
      this.assertTrusted(ownership);
      return this.validateRegistrationResult(request, response);
    } catch (error) {
      throw this.sanitize(error);
    }
  }

  async updateExistingService(
    request: V1EcsUpdateExistingServiceRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ serviceArn: string }> {
    try {
      this.assertServiceRequest(request);
      this.assertTrusted(ownership);
      const current = await this.client.send(
        new DescribeServicesCommand({
          cluster: request.clusterArn,
          services: [request.serviceArn],
        }),
        { abortSignal: ownership.signal },
      ) as DescribeServicesCommandOutput;
      this.assertTrusted(ownership);
      this.validateExistingService(request, current);

      const response = await this.client.send(
        new UpdateServiceCommand({
          cluster: request.clusterArn,
          service: request.serviceArn,
          taskDefinition: request.taskDefinitionArn,
          forceNewDeployment: true,
        }),
        { abortSignal: ownership.signal },
      ) as UpdateServiceCommandOutput;
      this.assertTrusted(ownership);
      const service = response.service;
      if (
        !service
        || service.serviceArn !== request.serviceArn
        || service.clusterArn !== request.clusterArn
        || service.taskDefinition !== request.taskDefinitionArn
        || service.status !== "ACTIVE"
      ) {
        throw new DisabledV1EcsMutationError(
          "ECS_MUTATION_RESULT_INVALID",
        );
      }
      return { serviceArn: service.serviceArn };
    } catch (error) {
      throw this.sanitize(error);
    }
  }

  private validateSourceTaskDefinition(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    response: DescribeTaskDefinitionCommandOutput,
  ) {
    const task = response.taskDefinition;
    if (!task) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_SOURCE_NOT_FOUND",
      );
    }
    const taskArn = task.taskDefinitionArn;
    if (
      taskArn !== request.sourceTaskDefinitionArn
      || task.family !== request.family
      || task.status !== "ACTIVE"
      || !TASK_DEFINITION_ARN.test(taskArn)
      || !IAM_ROLE_ARN.test(task.taskRoleArn ?? "")
      || !IAM_ROLE_ARN.test(task.executionRoleArn ?? "")
      || task.networkMode !== "awsvpc"
      || !Array.isArray(task.containerDefinitions)
      || task.containerDefinitions.length < 1
      || (task.volumes !== undefined && !Array.isArray(task.volumes))
      || !Array.isArray(task.requiresCompatibilities)
      || !task.requiresCompatibilities.includes("FARGATE")
      || new Set(task.containerDefinitions.map((item) => item.name)).size
        !== task.containerDefinitions.length
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
      );
    }
    for (const container of task.containerDefinitions) {
      this.assertContainerShape(container);
    }
    const matching = task.containerDefinitions.filter((container) =>
      container.name === request.containerName
    );
    if (matching.length !== 1) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_IDENTITY_MISMATCH",
      );
    }
    const target = matching[0];
    const mappings = target.portMappings ?? [];
    const logOptions = target.logConfiguration?.options;
    if (
      mappings.length !== 1
      || mappings[0].containerPortRange !== undefined
      || target.logConfiguration?.logDriver !== "awslogs"
      || !logOptions
      || logOptions["awslogs-group"] !== request.logGroupName
      || logOptions["awslogs-region"] !== request.region
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
      );
    }
    return { task, target };
  }

  private buildRegistrationRequest(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    sourceResponse: DescribeTaskDefinitionCommandOutput,
    source: ReturnType<
      DisabledV1EcsMutationClient["validateSourceTaskDefinition"]
    >,
    runtime: V1ResolvedEcsRuntimeReferences,
  ): RegisterTaskDefinitionCommandInput {
    const target = source.target;
    const existingPort = target.portMappings![0];
    const containers = source.task.containerDefinitions!.map((container) => {
      if (container.name !== request.containerName) {
        return { ...container };
      }
      const replacement: ContainerDefinition = {
        ...container,
        image: request.immutableImage,
        command: request.command === null
          ? undefined
          : ["sh", "-c", request.command],
        portMappings: [{
          ...existingPort,
          containerPort: request.containerPort,
          hostPort: request.containerPort,
        }],
        environment: runtime.environment.map((item) => ({ ...item })),
        secrets: runtime.secrets.map((item) => ({ ...item })),
      };
      return replacement;
    });
    return {
      family: request.family,
      taskRoleArn: source.task.taskRoleArn,
      executionRoleArn: source.task.executionRoleArn,
      networkMode: source.task.networkMode,
      containerDefinitions: containers,
      volumes: source.task.volumes?.map((volume) => ({ ...volume })),
      placementConstraints:
        source.task.placementConstraints?.map((item) => ({ ...item })),
      requiresCompatibilities: [...source.task.requiresCompatibilities!],
      cpu: String(request.cpu),
      memory: String(request.memory),
      tags: this.registrationTags(sourceResponse.tags, request),
      pidMode: source.task.pidMode,
      ipcMode: source.task.ipcMode,
      proxyConfiguration: source.task.proxyConfiguration
        ? { ...source.task.proxyConfiguration }
        : undefined,
      inferenceAccelerators:
        source.task.inferenceAccelerators?.map((item) => ({ ...item })),
      ephemeralStorage: source.task.ephemeralStorage
        ? { ...source.task.ephemeralStorage }
        : undefined,
      runtimePlatform: source.task.runtimePlatform
        ? { ...source.task.runtimePlatform }
        : undefined,
      enableFaultInjection: source.task.enableFaultInjection,
    };
  }

  private registrationTags(
    sourceTags: DescribeTaskDefinitionCommandOutput["tags"],
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
  ): Tag[] {
    const required = new Map<string, string>([
      [V1_ECS_RELEASE_EVIDENCE_TAGS.projectId,
        request.evidenceTags.projectId],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.environmentName,
        request.evidenceTags.environmentName],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId,
        request.evidenceTags.releaseManifestId],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision,
        request.evidenceTags.releaseRevision],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId,
        request.evidenceTags.infrastructureManifestId],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision,
        request.evidenceTags.infrastructureRevision],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash,
        request.evidenceTags.taskDefinitionInputHash],
      [V1_ECS_RELEASE_EVIDENCE_TAGS.imageDigest,
        request.evidenceTags.imageDigest],
    ]);
    const tags = new Map<string, string>();
    for (const tag of sourceTags ?? []) {
      if (
        typeof tag.key !== "string"
        || typeof tag.value !== "string"
        || tag.key.length < 1
        || tag.key.length > 128
        || tag.value.length > 256
        || /^aws:/i.test(tag.key)
        || tags.has(tag.key)
      ) {
        throw new DisabledV1EcsMutationError(
          "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
        );
      }
      if (!required.has(tag.key)) tags.set(tag.key, tag.value);
    }
    for (const [key, value] of required) tags.set(key, value);
    if (tags.size > 50) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
      );
    }
    return [...tags.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }));
  }

  private validateResolvedReferences(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    result: V1ResolvedEcsRuntimeReferences,
  ): V1ResolvedEcsRuntimeReferences {
    if (
      !result
      || Object.keys(result).sort().join(",") !== "environment,secrets"
      || !Array.isArray(result.environment)
      || !Array.isArray(result.secrets)
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_REFERENCE_RESOLUTION_INVALID",
      );
    }
    const plain = request.environmentReferences
      .filter((item) => item.source === "configuration_snapshot")
      .map((item) => item.name)
      .sort();
    const secret = request.environmentReferences
      .filter((item) => item.source === "secret_reference")
      .map((item) => item.name)
      .sort();
    const environmentNames = result.environment.map((item) => item.name).sort();
    const secretNames = result.secrets.map((item) => item.name).sort();
    if (
      plain.join("\0") !== environmentNames.join("\0")
      || secret.join("\0") !== secretNames.join("\0")
      || new Set(environmentNames).size !== environmentNames.length
      || new Set(secretNames).size !== secretNames.length
      || result.environment.some((item) =>
        Object.keys(item).sort().join(",") !== "name,value"
        || !VARIABLE_NAME.test(item.name)
        || SECRET_LIKE_NAME.test(item.name)
        || typeof item.value !== "string"
        || item.value.length > 8_192
        || item.value.includes("\0")
      )
      || result.secrets.some((item) =>
        Object.keys(item).sort().join(",") !== "name,valueFrom"
        || !VARIABLE_NAME.test(item.name)
        || !SECRET_VALUE_FROM.test(item.valueFrom)
      )
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_REFERENCE_RESOLUTION_INVALID",
      );
    }
    return {
      environment: result.environment.map((item) => ({ ...item })),
      secrets: result.secrets.map((item) => ({ ...item })),
    };
  }

  private validateRegistrationResult(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    response: RegisterTaskDefinitionCommandOutput,
  ) {
    const task = response.taskDefinition;
    const arn = task?.taskDefinitionArn;
    const match = typeof arn === "string"
      ? TASK_DEFINITION_ARN.exec(arn)
      : null;
    const target = task?.containerDefinitions?.filter((container) =>
      container.name === request.containerName
    ) ?? [];
    const tags = new Map(
      (response.tags ?? []).map((tag) => [tag.key, tag.value]),
    );
    if (
      !task
      || !match
      || task.family !== request.family
      || match[4] !== request.family
      || task.status !== "ACTIVE"
      || task.cpu !== String(request.cpu)
      || task.memory !== String(request.memory)
      || target.length !== 1
      || target[0].image !== request.immutableImage
      || Object.entries(V1_ECS_RELEASE_EVIDENCE_TAGS).some(
        ([identityKey, awsKey]) =>
          tags.get(awsKey)
            !== request.evidenceTags[
              identityKey as keyof typeof request.evidenceTags
            ],
      )
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_RESULT_INVALID",
      );
    }
    return { taskDefinitionArn: arn! };
  }

  private validateExistingService(
    request: V1EcsUpdateExistingServiceRequest,
    response: DescribeServicesCommandOutput,
  ) {
    if ((response.failures?.length ?? 0) > 0) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_IDENTITY_MISMATCH",
      );
    }
    const services = response.services ?? [];
    if (
      services.length !== 1
      || services[0].serviceArn !== request.serviceArn
      || services[0].clusterArn !== request.clusterArn
      || services[0].status !== "ACTIVE"
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_IDENTITY_MISMATCH",
      );
    }
  }

  private assertRegistrationRequest(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
  ) {
    const task = TASK_DEFINITION_ARN.exec(
      request?.sourceTaskDefinitionArn ?? "",
    );
    const imageDigest = request?.immutableImage?.split("@")[1];
    const evidence = request?.evidenceTags;
    if (
      request?.region !== this.options.region
      || !task
      || task[2] !== request.region
      || task[4] !== request.family
      || !FAMILY.test(request.family)
      || !CONTAINER_NAME.test(request.containerName)
      || !IMMUTABLE_IMAGE.test(request.immutableImage)
      || !Number.isInteger(request.containerPort)
      || request.containerPort < 1
      || request.containerPort > 65_535
      || !Number.isInteger(request.cpu)
      || !Number.isInteger(request.memory)
      || !this.validFargateSize(request.cpu, request.memory)
      || !LOG_GROUP.test(request.logGroupName)
      || (
        request.command !== null
        && (
          typeof request.command !== "string"
          || request.command.length < 1
          || request.command.length > 4_096
          || request.command.includes("\0")
        )
      )
      || !Array.isArray(request.environmentReferences)
      || !Array.isArray(request.serviceBindingReferences)
      || !evidence
      || !UUID.test(evidence.projectId)
      || !ENVIRONMENT_NAME.test(evidence.environmentName)
      || !UUID.test(evidence.releaseManifestId)
      || !REVISION.test(evidence.releaseRevision)
      || !UUID.test(evidence.infrastructureManifestId)
      || !REVISION.test(evidence.infrastructureRevision)
      || !HASH.test(evidence.taskDefinitionInputHash)
      || !IMAGE_DIGEST.test(evidence.imageDigest)
      || evidence.imageDigest !== imageDigest
      || this.invalidEnvironmentReferences(request.environmentReferences)
      || this.invalidBindingReferences(request.serviceBindingReferences)
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_CONTRACT_INVALID",
      );
    }
  }

  private assertServiceRequest(request: V1EcsUpdateExistingServiceRequest) {
    const cluster = CLUSTER_ARN.exec(request?.clusterArn ?? "");
    const service = SERVICE_ARN.exec(request?.serviceArn ?? "");
    const task = TASK_DEFINITION_ARN.exec(request?.taskDefinitionArn ?? "");
    if (
      request?.region !== this.options.region
      || !cluster
      || !service
      || !task
      || cluster[2] !== request.region
      || service[2] !== request.region
      || task[2] !== request.region
      || cluster[1] !== service[1]
      || cluster[1] !== task[1]
      || cluster[3] !== service[3]
      || cluster[3] !== task[3]
      || request.forceNewDeployment !== true
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_CONTRACT_INVALID",
      );
    }
  }

  private invalidEnvironmentReferences(
    references: V1EcsEnvironmentReference[],
  ) {
    const names = new Set<string>();
    return references.some((item) => {
      if (
        !item
        || Object.keys(item).sort().join(",")
          !== "configurationSnapshotId,name,source"
        || !VARIABLE_NAME.test(item.name)
        || (
          item.source !== "configuration_snapshot"
          && item.source !== "secret_reference"
        )
        || !UUID.test(item.configurationSnapshotId)
        || names.has(item.name)
      ) return true;
      names.add(item.name);
      return item.source === "configuration_snapshot"
        && SECRET_LIKE_NAME.test(item.name);
    });
  }

  private invalidBindingReferences(
    references: V1EcsServiceBindingReference[],
  ) {
    const ids = new Set<string>();
    return references.some((item) => {
      const key = `${item?.id}:${item?.revision}`;
      if (
        !item
        || Object.keys(item).sort().join(",") !== "id,revision"
        || !UUID.test(item.id)
        || !REVISION.test(item.revision)
        || ids.has(key)
      ) return true;
      ids.add(key);
      return false;
    });
  }

  private assertContainerShape(container: ContainerDefinition) {
    if (
      !container
      || !CONTAINER_NAME.test(container.name ?? "")
      || typeof container.image !== "string"
      || container.image.length < 1
      || (
        container.environment !== undefined
        && !Array.isArray(container.environment)
      )
      || (container.secrets !== undefined && !Array.isArray(container.secrets))
      || (container.environment ?? []).some((item) =>
        !VARIABLE_NAME.test(item.name ?? "")
        || typeof item.value !== "string"
        || SECRET_LIKE_NAME.test(item.name ?? "")
      )
      || (container.secrets ?? []).some((item) =>
        !VARIABLE_NAME.test(item.name ?? "")
        || !SECRET_VALUE_FROM.test(item.valueFrom ?? "")
      )
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
      );
    }
  }

  private assertTrusted(ownership: V1HandlerSideEffectExecutorContext) {
    if (ownership?.signal?.aborted) {
      throw new DisabledV1EcsMutationError("ECS_MUTATION_CANCELLED");
    }
    if (
      !ownership
      || typeof ownership.isLeaseTrusted !== "function"
      || !ownership.isLeaseTrusted()
    ) {
      throw new DisabledV1EcsMutationError(
        "ECS_MUTATION_OWNERSHIP_LOST",
      );
    }
  }

  private validFargateSize(cpu: number, memory: number) {
    if (cpu === 256) return [512, 1024, 2048].includes(memory);
    if (cpu === 512) {
      return memory >= 1024 && memory <= 4096 && memory % 1024 === 0;
    }
    if (cpu === 1024) {
      return memory >= 2048 && memory <= 8192 && memory % 1024 === 0;
    }
    if (cpu === 2048) {
      return memory >= 4096 && memory <= 16384 && memory % 1024 === 0;
    }
    if (cpu === 4096) {
      return memory >= 8192 && memory <= 30720 && memory % 1024 === 0;
    }
    if (cpu === 8192) {
      return memory >= 16384 && memory <= 61440 && memory % 4096 === 0;
    }
    return cpu === 16384
      && memory >= 32768
      && memory <= 122880
      && memory % 8192 === 0;
  }

  private sanitize(error: unknown) {
    if (error instanceof DisabledV1EcsMutationError) return error;
    return new DisabledV1EcsMutationError(
      "ECS_MUTATION_RESULT_UNCERTAIN",
    );
  }
}
