import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
} from "@aws-sdk/client-ecs";
import type {
  DescribeServicesCommandOutput,
  DescribeTaskDefinitionCommandOutput,
  ECSClient,
  ListTaskDefinitionsCommandOutput,
} from "@aws-sdk/client-ecs";
import {
  V1EcsReleaseReadOnlyClient,
  V1EcsServiceUpdateEvidenceQuery,
  V1EcsServiceUpdateReadEvidence,
  V1EcsTaskDefinitionEvidenceQuery,
  V1EcsTaskDefinitionReadEvidence,
} from "./inactive-v1-ecs-release-reconciliation.types";

const TASK_DEFINITION_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;
const CLUSTER_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[A-Za-z0-9_.\/-]+$/;
const SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9+/=_:.-]{1,4096}$/;

export const V1_ECS_RELEASE_EVIDENCE_TAGS = Object.freeze({
  projectId: "deployguard:project-id",
  environmentName: "deployguard:environment",
  releaseManifestId: "deployguard:release-manifest-id",
  releaseRevision: "deployguard:release-revision",
  infrastructureManifestId: "deployguard:infrastructure-manifest-id",
  infrastructureRevision: "deployguard:infrastructure-revision",
  taskDefinitionInputHash: "deployguard:task-definition-input-hash",
  imageDigest: "deployguard:image-digest",
});

export type V1InjectedEcsReadClient = Pick<ECSClient, "send">;

export type V1DisabledEcsReadOnlyEvidenceOptions = {
  region: string;
  maxPages?: number;
  pageSize?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type ReaderErrorCode =
  | "ECS_READ_CONTRACT_INVALID"
  | "ECS_READ_CANCELLED"
  | "ECS_READ_FAILED"
  | "ECS_READ_MALFORMED"
  | "ECS_READ_NOT_FOUND"
  | "ECS_READ_PAGINATION_INVALID"
  | "ECS_READ_THROTTLED";

class DisabledV1EcsReadError extends Error {
  constructor(readonly code: ReaderErrorCode) {
    super(code);
    this.name = "DisabledV1EcsReadError";
  }
}

type TaskDescription = {
  arn: string;
  family: string;
  containerName: string;
  image: string;
  status: "ACTIVE" | "INACTIVE";
  tags: ReadonlyMap<string, string>;
};

export class DisabledV1EcsReadOnlyEvidenceClient
implements V1EcsReleaseReadOnlyClient {
  readonly policy =
    "deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1" as const;

  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly client: V1InjectedEcsReadClient,
    private readonly options: V1DisabledEcsReadOnlyEvidenceOptions,
  ) {
    this.maxPages = options.maxPages ?? 10;
    this.pageSize = options.pageSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 50;
    this.sleep = options.sleep ?? this.abortableSleep;
    if (
      !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/.test(options.region)
      || !Number.isInteger(this.maxPages)
      || this.maxPages < 1
      || this.maxPages > 20
      || !Number.isInteger(this.pageSize)
      || this.pageSize < 1
      || this.pageSize > 100
      || !Number.isInteger(this.maxAttempts)
      || this.maxAttempts < 1
      || this.maxAttempts > 5
      || !Number.isInteger(this.baseRetryDelayMs)
      || this.baseRetryDelayMs < 0
      || this.baseRetryDelayMs > 5_000
    ) {
      throw new DisabledV1EcsReadError("ECS_READ_CONTRACT_INVALID");
    }
  }

  async findTaskDefinitionEvidence(
    query: V1EcsTaskDefinitionEvidenceQuery,
    signal: AbortSignal,
  ): Promise<readonly V1EcsTaskDefinitionReadEvidence[]> {
    try {
      this.assertTaskQuery(query);
      const descriptions = query.expectedTaskDefinitionArn
        ? [
            await this.describeTaskDefinition(
              query.expectedTaskDefinitionArn,
              query.containerName,
              signal,
            ),
          ].filter((item): item is TaskDescription => item !== null)
        : await this.discoverTaskDefinitions(query, signal);
      const relevant = descriptions.filter((item) =>
        this.isRelevantTaskEvidence(query, item)
      );
      return relevant.map((item) => this.taskEvidence(item));
    } catch (error) {
      return this.taskFailureEvidence(error);
    }
  }

  async findServiceUpdateEvidence(
    query: V1EcsServiceUpdateEvidenceQuery,
    signal: AbortSignal,
  ): Promise<readonly V1EcsServiceUpdateReadEvidence[]> {
    try {
      this.assertServiceQuery(query);
      const response = await this.sendWithRetry(
        () => this.client.send(new DescribeServicesCommand({
          cluster: query.clusterArn,
          services: [query.serviceArn],
          include: ["TAGS"],
        }), { abortSignal: signal }),
        signal,
      ) as DescribeServicesCommandOutput;
      if (response.failures?.length) {
        if (
          (response.services?.length ?? 0) === 0
          && response.failures.every((failure) =>
            failure.reason === "MISSING"
          )
        ) {
          return [];
        }
        throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
      }
      const services = response.services ?? [];
      if (services.length === 0) return [];
      if (services.length !== 1) {
        throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
      }
      const service = services[0];
      if (
        typeof service.serviceArn !== "string"
        || typeof service.clusterArn !== "string"
        || !Array.isArray(service.deployments)
        || (
          service.status !== "ACTIVE"
          && service.status !== "DRAINING"
          && service.status !== "INACTIVE"
        )
      ) {
        throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
      }
      const matching = service.deployments.filter((deployment) =>
        deployment.taskDefinition === query.taskDefinitionArn
      );
      if (matching.length === 0) {
        if (service.taskDefinition === query.taskDefinitionArn) {
          throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
        }
        return [];
      }
      const task = await this.describeTaskDefinition(
        query.taskDefinitionArn,
        query.containerName,
        signal,
      );
      if (!task) return [];
      return matching.map((deployment) => {
        if (
          deployment.rolloutState !== "COMPLETED"
          && deployment.rolloutState !== "IN_PROGRESS"
          && deployment.rolloutState !== "FAILED"
        ) {
          throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
        }
        const identity = this.taskIdentity(task);
        return {
          clusterArn: service.clusterArn!,
          serviceArn: service.serviceArn!,
          family: task.family,
          containerName: task.containerName,
          ...identity,
          serviceUpdateInputHash: query.serviceUpdateInputHash,
          taskDefinitionArn: task.arn,
          taskDefinitionStatus: task.status,
          serviceStatus: service.status as
            "ACTIVE" | "DRAINING" | "INACTIVE",
          rolloutState: deployment.rolloutState,
        };
      });
    } catch (error) {
      return this.serviceFailureEvidence(error);
    }
  }

  private async discoverTaskDefinitions(
    query: V1EcsTaskDefinitionEvidenceQuery,
    signal: AbortSignal,
  ) {
    const arns = [
      ...await this.listTaskDefinitions(query.family, "ACTIVE", signal),
      ...await this.listTaskDefinitions(query.family, "INACTIVE", signal),
    ];
    if (new Set(arns).size !== arns.length) {
      throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
    }
    const descriptions: TaskDescription[] = [];
    for (const arn of arns) {
      const description = await this.describeTaskDefinition(
        arn,
        query.containerName,
        signal,
      );
      if (description) descriptions.push(description);
    }
    return descriptions;
  }

  private async listTaskDefinitions(
    family: string,
    status: "ACTIVE" | "INACTIVE",
    signal: AbortSignal,
  ) {
    const arns: string[] = [];
    const tokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.sendWithRetry(
        () => this.client.send(new ListTaskDefinitionsCommand({
          familyPrefix: family,
          status,
          sort: "DESC",
          maxResults: this.pageSize,
          nextToken,
        }), { abortSignal: signal }),
        signal,
      ) as ListTaskDefinitionsCommandOutput;
      const pageArns = response.taskDefinitionArns ?? [];
      if (
        !Array.isArray(pageArns)
        || pageArns.some((arn) =>
          typeof arn !== "string" || !TASK_DEFINITION_ARN.test(arn)
        )
      ) {
        throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
      }
      arns.push(...pageArns);
      nextToken = response.nextToken;
      if (nextToken === undefined) return arns;
      if (!OPAQUE_TOKEN.test(nextToken) || tokens.has(nextToken)) {
        throw new DisabledV1EcsReadError(
          "ECS_READ_PAGINATION_INVALID",
        );
      }
      tokens.add(nextToken);
    }
    throw new DisabledV1EcsReadError("ECS_READ_PAGINATION_INVALID");
  }

  private async describeTaskDefinition(
    arn: string,
    containerName: string,
    signal: AbortSignal,
  ): Promise<TaskDescription | null> {
    let response: DescribeTaskDefinitionCommandOutput;
    try {
      response = await this.sendWithRetry(
        () => this.client.send(new DescribeTaskDefinitionCommand({
          taskDefinition: arn,
          include: ["TAGS"],
        }), { abortSignal: signal }),
        signal,
      ) as DescribeTaskDefinitionCommandOutput;
    } catch (error) {
      if (
        error instanceof DisabledV1EcsReadError
        && error.code === "ECS_READ_NOT_FOUND"
      ) {
        return null;
      }
      throw error;
    }
    const task = response.taskDefinition;
    if (
      !task
      || task.taskDefinitionArn !== arn
      || typeof task.family !== "string"
      || !Array.isArray(task.containerDefinitions)
      || (task.status !== "ACTIVE" && task.status !== "INACTIVE")
    ) {
      throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
    }
    const containers = task.containerDefinitions.filter((container) =>
      typeof container.name === "string"
    );
    if (containers.length === 0) {
      throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
    }
    const tags = this.tagMap(response.tags);
    const matching = containers.filter((container) =>
      container.name === containerName
    );
    if (
      matching.length !== 1
      || typeof matching[0].name !== "string"
      || typeof matching[0].image !== "string"
    ) {
      throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
    }
    return {
      arn,
      family: task.family,
      containerName: matching[0].name,
      image: matching[0].image,
      status: task.status,
      tags,
    };
  }

  private taskEvidence(
    task: TaskDescription,
  ): V1EcsTaskDefinitionReadEvidence {
    const identity = this.taskIdentity(task);
    return {
      taskDefinitionArn: task.arn,
      family: task.family,
      containerName: task.containerName,
      ...identity,
      immutableImage: task.image,
      status: task.status,
    };
  }

  private taskIdentity(task: TaskDescription) {
    return {
      projectId: task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.projectId)
        ?? "",
      environmentName:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.environmentName) ?? "",
      releaseManifestId:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId)
        ?? "",
      releaseRevision:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision) ?? "",
      infrastructureManifestId:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId)
        ?? "",
      infrastructureRevision:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision)
        ?? "",
      taskDefinitionInputHash:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash)
        ?? "",
      imageDigest:
        task.tags.get(V1_ECS_RELEASE_EVIDENCE_TAGS.imageDigest) ?? "",
    };
  }

  private isRelevantTaskEvidence(
    query: V1EcsTaskDefinitionEvidenceQuery,
    task: TaskDescription,
  ) {
    const identity = this.taskIdentity(task);
    return query.expectedTaskDefinitionArn === task.arn
      || identity.releaseManifestId === query.releaseManifestId
      || identity.taskDefinitionInputHash === query.taskDefinitionInputHash
      || task.image === query.immutableImage;
  }

  private tagMap(
    tags: DescribeTaskDefinitionCommandOutput["tags"],
  ) {
    const result = new Map<string, string>();
    for (const tag of tags ?? []) {
      if (
        typeof tag.key !== "string"
        || typeof tag.value !== "string"
        || result.has(tag.key)
      ) {
        throw new DisabledV1EcsReadError("ECS_READ_MALFORMED");
      }
      result.set(tag.key, tag.value);
    }
    return result;
  }

  private async sendWithRetry(
    operation: () => Promise<unknown>,
    signal: AbortSignal,
  ) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.assertNotCancelled(signal);
      try {
        return await operation();
      } catch (error) {
        this.assertNotCancelled(signal);
        if (this.errorName(error) === "ClientException") {
          throw new DisabledV1EcsReadError("ECS_READ_NOT_FOUND");
        }
        if (!this.isThrottling(error)) {
          throw error instanceof DisabledV1EcsReadError
            ? error
            : new DisabledV1EcsReadError("ECS_READ_FAILED");
        }
        if (attempt === this.maxAttempts) {
          throw new DisabledV1EcsReadError("ECS_READ_THROTTLED");
        }
        await this.sleep(
          this.baseRetryDelayMs * (2 ** (attempt - 1)),
          signal,
        );
      }
    }
    throw new DisabledV1EcsReadError("ECS_READ_FAILED");
  }

  private taskFailureEvidence(error: unknown) {
    if (
      error instanceof DisabledV1EcsReadError
      && (
        error.code === "ECS_READ_THROTTLED"
        || error.code === "ECS_READ_CANCELLED"
      )
    ) {
      return [];
    }
    return [{
      taskDefinitionArn: "",
      family: "",
      containerName: "",
      projectId: "",
      environmentName: "",
      releaseManifestId: "",
      releaseRevision: "",
      infrastructureManifestId: "",
      infrastructureRevision: "",
      taskDefinitionInputHash: "",
      immutableImage: "",
      imageDigest: "",
      status: "ACTIVE" as const,
    }];
  }

  private serviceFailureEvidence(error: unknown) {
    if (
      error instanceof DisabledV1EcsReadError
      && (
        error.code === "ECS_READ_THROTTLED"
        || error.code === "ECS_READ_CANCELLED"
      )
    ) {
      return [];
    }
    return [{
      clusterArn: "",
      serviceArn: "",
      family: "",
      containerName: "",
      projectId: "",
      environmentName: "",
      releaseManifestId: "",
      releaseRevision: "",
      infrastructureManifestId: "",
      infrastructureRevision: "",
      taskDefinitionInputHash: "",
      serviceUpdateInputHash: "",
      taskDefinitionArn: "",
      taskDefinitionStatus: "ACTIVE" as const,
      imageDigest: "",
      serviceStatus: "ACTIVE" as const,
      rolloutState: "IN_PROGRESS" as const,
    }];
  }

  private assertTaskQuery(query: V1EcsTaskDefinitionEvidenceQuery) {
    if (
      query.region !== this.options.region
      || !/^[A-Za-z0-9_-]{1,255}$/.test(query.family)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(
        query.containerName,
      )
      || !UUID.test(query.projectId)
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(query.environmentName)
      || !UUID.test(query.releaseManifestId)
      || !/^[1-9][0-9]*$/.test(query.releaseRevision)
      || !UUID.test(query.infrastructureManifestId)
      || !/^[1-9][0-9]*$/.test(query.infrastructureRevision)
      || !HASH.test(query.taskDefinitionInputHash)
      || (
        query.expectedTaskDefinitionArn !== null
        && !TASK_DEFINITION_ARN.test(query.expectedTaskDefinitionArn)
      )
      || !IMMUTABLE_IMAGE.test(query.immutableImage)
      || !IMAGE_DIGEST.test(query.imageDigest)
      || !query.immutableImage.endsWith(`@${query.imageDigest}`)
    ) {
      throw new DisabledV1EcsReadError("ECS_READ_CONTRACT_INVALID");
    }
  }

  private assertServiceQuery(query: V1EcsServiceUpdateEvidenceQuery) {
    this.assertTaskQuery(query);
    if (
      !CLUSTER_ARN.test(query.clusterArn)
      || !SERVICE_ARN.test(query.serviceArn)
      || !TASK_DEFINITION_ARN.test(query.taskDefinitionArn)
      || query.expectedTaskDefinitionArn !== query.taskDefinitionArn
      || !HASH.test(query.serviceUpdateInputHash)
    ) {
      throw new DisabledV1EcsReadError("ECS_READ_CONTRACT_INVALID");
    }
  }

  private assertNotCancelled(signal: AbortSignal) {
    if (signal.aborted) {
      throw new DisabledV1EcsReadError("ECS_READ_CANCELLED");
    }
  }

  private isThrottling(error: unknown) {
    const name = this.errorName(error);
    const status = error && typeof error === "object"
      ? (error as { $metadata?: { httpStatusCode?: unknown } })
        .$metadata?.httpStatusCode
      : undefined;
    return name === "ThrottlingException"
      || name === "Throttling"
      || name === "TooManyRequestsException"
      || status === 429;
  }

  private errorName(error: unknown) {
    if (!error || typeof error !== "object") return "";
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }

  private async abortableSleep(
    milliseconds: number,
    signal: AbortSignal,
  ) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DisabledV1EcsReadError("ECS_READ_CANCELLED"));
      }, { once: true });
    });
  }
}
