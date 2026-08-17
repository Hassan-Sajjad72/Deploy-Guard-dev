import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DescribeImagesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";
import {
  CreateServiceCommand,
  DescribeServicesCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1FirstReleaseBootstrapClient,
  V1FirstReleaseImageBuildRequest,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseHealthEvidence,
  V1FirstReleaseHealthRequest,
  V1FirstReleaseServiceRequest,
  V1FirstReleaseTaskDefinitionRequest,
} from "./inactive-v1-first-release-bootstrap.types";
import { V1HandlerSideEffectExecutorContext } from "./v1-handler-side-effect.types";

const execFile = promisify(execFileCallback);
const COMMIT = /^[0-9a-f]{40,64}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const APP_ROOT = /^(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ECR_REPOSITORY = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*$/;
const ARN = /^arn:(?:aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:.+$/;

/**
 * Explicitly constructed only by the exact production-canary composition.
 * No Nest lifecycle hook invokes this client; all mutation methods still need
 * a fenced side-effect context from the one-shot runner.
 */
export class ProductionV1FirstReleaseBootstrapClient
implements V1FirstReleaseBootstrapClient {
  readonly policy = "deployguard.first-release-bootstrap/client-v1" as const;

  constructor(
    private readonly dataSource: DataSource,
    private readonly ecr: Pick<ECRClient, "send">,
    private readonly ecs: Pick<ECSClient, "send">,
    private readonly elbv2: Pick<ElasticLoadBalancingV2Client, "send">,
  ) {}

  async buildAndPushImmutableImage(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence> {
    this.assertBuildInput(input);
    this.assertTrusted(ownership);
    const dockerfile = await this.loadPinnedDockerfile(input);
    this.assertTrusted(ownership);

    const workspace = await mkdtemp(join(tmpdir(), "deployguard-first-release-"));
    try {
      const repositoryDirectory = join(workspace, "repository");
      await this.command("git", ["clone", "--no-checkout", `https://github.com/${input.repositoryFullName}.git`, repositoryDirectory], ownership);
      await this.command("git", ["-C", repositoryDirectory, "fetch", "--depth", "1", "origin", input.commitSha], ownership);
      await this.command("git", ["-C", repositoryDirectory, "checkout", "--detach", input.commitSha], ownership);
      const { stdout } = await this.command("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"], ownership);
      if (stdout.trim().toLowerCase() !== input.commitSha.toLowerCase()) {
        throw new Error("FIRST_RELEASE_SOURCE_PIN_MISMATCH");
      }
      const applicationDirectory = this.appDirectory(repositoryDirectory, input.appRoot);
      if (input.dockerStrategy === "generated") {
        await writeFile(join(applicationDirectory, "Dockerfile"), dockerfile, "utf8");
      } else {
        const existing = await readFile(join(applicationDirectory, "Dockerfile"), "utf8").catch(() => null);
        if (!existing || existing.length > 128 * 1024) {
          throw new Error("FIRST_RELEASE_DOCKERFILE_UNAVAILABLE");
        }
      }
      const localImage = `deployguard-first-${input.projectId.slice(0, 8)}`;
      const tag = input.commitSha.toLowerCase();
      await this.command("docker", ["build", "--pull", "--tag", `${localImage}:${tag}`, applicationDirectory], ownership, 10 * 60 * 1000)
        .catch(() => { throw new Error("FIRST_RELEASE_DOCKER_BUILD_FAILED"); });
      await this.loginDocker(input.region, ownership)
        .catch(() => { throw new Error("FIRST_RELEASE_ECR_LOGIN_FAILED"); });
      await this.command("docker", ["tag", `${localImage}:${tag}`, `${input.repositoryUrl}:${tag}`], ownership)
        .catch(() => { throw new Error("FIRST_RELEASE_DOCKER_TAG_FAILED"); });
      await this.command("docker", ["push", `${input.repositoryUrl}:${tag}`], ownership, 10 * 60 * 1000);
      this.assertTrusted(ownership);
      const image = await this.ecr.send(new DescribeImagesCommand({
        repositoryName: input.repositoryUrl.split("/").slice(1).join("/"),
        imageIds: [{ imageTag: tag }],
      }), { abortSignal: ownership.signal });
      this.assertTrusted(ownership);
      const digest = image.imageDetails?.length === 1
        ? image.imageDetails[0].imageDigest
        : null;
      if (typeof digest !== "string" || !DIGEST.test(digest)) {
        throw new Error("FIRST_RELEASE_ECR_DIGEST_UNAVAILABLE");
      }
      return {
        imageUri: input.repositoryUrl,
        imageDigest: digest,
        commitSha: input.commitSha,
        buildFingerprint: input.buildFingerprint,
      };
    } catch (error) {
      throw this.safeError(error);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async resolveImmutableImageEvidence(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence> {
    this.assertBuildInput(input);
    this.assertTrusted(ownership);
    try {
      const image = await this.ecr.send(new DescribeImagesCommand({
        repositoryName: input.repositoryUrl.split("/").slice(1).join("/"),
        imageIds: [{ imageTag: input.commitSha.toLowerCase() }],
      }), { abortSignal: ownership.signal });
      this.assertTrusted(ownership);
      const digest = image.imageDetails?.length === 1
        ? image.imageDetails[0].imageDigest
        : null;
      if (typeof digest !== "string" || !DIGEST.test(digest)) {
        throw new Error("FIRST_RELEASE_ECR_DIGEST_UNAVAILABLE");
      }
      return {
        imageUri: input.repositoryUrl,
        imageDigest: digest,
        commitSha: input.commitSha,
        buildFingerprint: input.buildFingerprint,
      };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async inspectExactService(
    input: { clusterArn: string; serviceName: string; infrastructureManifestId: string; infrastructureRevision: string },
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ state: "absent" | "present" | "ambiguous" }> {
    this.assertTrusted(ownership);
    if (!ARN.test(input.clusterArn) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(input.serviceName)) {
      throw new Error("FIRST_RELEASE_SERVICE_PROBE_INVALID");
    }
    try {
      const response = await this.ecs.send(new DescribeServicesCommand({
        cluster: input.clusterArn,
        services: [input.serviceName],
      }), { abortSignal: ownership.signal });
      this.assertTrusted(ownership);
      if ((response.services?.length ?? 0) === 0
        && response.failures?.length === 1
        && response.failures[0]?.reason === "MISSING") return { state: "absent" };
      if ((response.services?.length ?? 0) === 1
        && response.services?.[0]?.serviceName === input.serviceName
        && response.services[0]?.clusterArn === input.clusterArn) return { state: "present" };
      return { state: "ambiguous" };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async registerInitialTaskDefinition(
    input: V1FirstReleaseTaskDefinitionRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ taskDefinitionArn: string }> {
    this.assertTrusted(ownership);
    if (input.environmentReferences.length || input.serviceBindingReferences.length) {
      throw new Error("FIRST_RELEASE_RUNTIME_REFERENCES_UNSUPPORTED");
    }
    if (!this.validRuntimeBindings(input.runtimeEnvironment, input.runtimeSecrets)) {
      throw new Error("FIRST_RELEASE_RUNTIME_REFERENCES_INVALID");
    }
    try {
      const response = await this.ecs.send(new RegisterTaskDefinitionCommand({
        family: input.family,
        taskRoleArn: input.taskRoleArn,
        executionRoleArn: input.executionRoleArn,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: String(input.cpu),
        memory: String(input.memory),
        containerDefinitions: [{
          name: input.containerName,
          image: input.immutableImage,
          command: input.command ? ["sh", "-c", input.command] : undefined,
          portMappings: [{ containerPort: input.containerPort, hostPort: input.containerPort, protocol: "tcp" }],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": input.logGroupName,
              "awslogs-region": input.region,
              "awslogs-stream-prefix": "app",
            },
          },
          essential: true,
          environment: input.runtimeEnvironment.map((entry) => ({ name: entry.name, value: entry.value })),
          secrets: input.runtimeSecrets.map((entry) => ({ name: entry.name, valueFrom: entry.valueFrom })),
        }],
        tags: Object.entries(input.evidenceTags)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      }), { abortSignal: ownership.signal });
      this.assertTrusted(ownership);
      const arn = response.taskDefinition?.taskDefinitionArn;
      if (typeof arn !== "string" || !ARN.test(arn)) throw new Error("FIRST_RELEASE_TASK_RESULT_INVALID");
      return { taskDefinitionArn: arn };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  private validRuntimeBindings(
    environment: ReadonlyArray<{ name: string; value: string }>,
    secrets: ReadonlyArray<{ name: string; valueFrom: string }>,
  ) {
    const safeName = /^[A-Z][A-Z0-9_]{0,127}$/;
    const safeValue = /^(?!.*(?:localhost|127\.0\.0\.1|password\s*=|secret\s*=))[A-Za-z0-9._:/=-]{1,512}$/i;
    const secretArn = /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
    const environmentNames = new Set<string>(); const secretNames = new Set<string>();
    return environment.every((entry) => safeName.test(entry.name) && safeValue.test(entry.value) && !environmentNames.has(entry.name) && (environmentNames.add(entry.name), true))
      && secrets.every((entry) => safeName.test(entry.name) && secretArn.test(entry.valueFrom) && !secretNames.has(entry.name) && (secretNames.add(entry.name), true));
  }

  async createInitialService(
    input: V1FirstReleaseServiceRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ serviceArn: string }> {
    this.assertTrusted(ownership);
    try {
      const response = await this.ecs.send(new CreateServiceCommand({
        cluster: input.clusterArn,
        serviceName: input.serviceName,
        taskDefinition: input.taskDefinitionArn,
        desiredCount: 1,
        launchType: "FARGATE",
        healthCheckGracePeriodSeconds: 120,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...input.subnetIds],
            securityGroups: [...input.securityGroupIds],
            assignPublicIp: input.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
        loadBalancers: [{
          targetGroupArn: input.targetGroupArn,
          containerName: input.containerName,
          containerPort: input.containerPort,
        }],
        tags: Object.entries(input.evidenceTags)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      }), { abortSignal: ownership.signal });
      this.assertTrusted(ownership);
      const arn = response.service?.serviceArn;
      if (typeof arn !== "string" || !ARN.test(arn)) throw new Error("FIRST_RELEASE_SERVICE_RESULT_INVALID");
      return { serviceArn: arn };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async verifyInitialRelease(
    input: V1FirstReleaseHealthRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseHealthEvidence> {
    this.assertTrusted(ownership);
    if (!ARN.test(input.clusterArn) || !ARN.test(input.serviceArn)
      || !ARN.test(input.taskDefinitionArn) || !ARN.test(input.targetGroupArn)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(input.serviceName)
      || !/^[A-Za-z0-9.-]{1,253}$/.test(input.loadBalancerDnsName)
      || !/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)$/.test(input.healthPath)
      || !Number.isInteger(input.containerPort) || input.containerPort < 1
      || input.containerPort > 65535 || !Number.isInteger(input.timeoutMs)
      || input.timeoutMs < 30_000 || input.timeoutMs > 30 * 60_000) {
      throw new Error("FIRST_RELEASE_HEALTH_CONTRACT_INVALID");
    }
    const deadline = Date.now() + input.timeoutMs;
    let lastCode = "FIRST_RELEASE_ROLLOUT_PROGRESSING";
    try {
      while (Date.now() < deadline) {
        this.assertTrusted(ownership);
        const serviceResponse = await this.ecs.send(new DescribeServicesCommand({
          cluster: input.clusterArn,
          services: [input.serviceArn],
        }), { abortSignal: ownership.signal });
        this.assertTrusted(ownership);
        const service = serviceResponse.services?.length === 1
          && !(serviceResponse.failures?.length)
          ? serviceResponse.services[0]
          : null;
        if (!service || service.serviceArn !== input.serviceArn
          || service.serviceName !== input.serviceName
          || service.clusterArn !== input.clusterArn
          || service.status !== "ACTIVE"
          || service.taskDefinition !== input.taskDefinitionArn) {
          throw new Error("FIRST_RELEASE_SERVICE_EVIDENCE_MISMATCH");
        }
        const deployments = service.deployments?.filter((item) =>
          item.taskDefinition === input.taskDefinitionArn && item.status === "PRIMARY") ?? [];
        if (deployments.length !== 1) throw new Error("FIRST_RELEASE_ROLLOUT_EVIDENCE_AMBIGUOUS");
        const deployment = deployments[0];
        if (deployment.rolloutState === "FAILED") throw new Error("FIRST_RELEASE_ROLLOUT_FAILED");
        if (deployment.rolloutState === "COMPLETED"
          && service.desiredCount === 1 && service.runningCount === 1
          && (service.pendingCount ?? 0) === 0) {
          const tasks = await this.ecs.send(new ListTasksCommand({
            cluster: input.clusterArn,
            serviceName: input.serviceName,
            desiredStatus: "RUNNING",
          }), { abortSignal: ownership.signal });
          this.assertTrusted(ownership);
          if ((tasks.taskArns?.length ?? 0) !== 1) {
            lastCode = "FIRST_RELEASE_TASK_EVIDENCE_PENDING";
          } else {
            const target = await this.elbv2.send(new DescribeTargetHealthCommand({
              TargetGroupArn: input.targetGroupArn,
            }), { abortSignal: ownership.signal });
            this.assertTrusted(ownership);
            const descriptions = target.TargetHealthDescriptions ?? [];
            const healthy = descriptions.filter((item) =>
              item.Target?.Port === input.containerPort
              && item.TargetHealth?.State === "healthy");
            if (descriptions.some((item) => item.TargetHealth?.State === "unhealthy")) {
              lastCode = "FIRST_RELEASE_TARGET_UNHEALTHY";
            } else if (descriptions.length === 1 && healthy.length === 1) {
              const applicationUrl = `http://${input.loadBalancerDnsName}${input.healthPath}`;
              if (await this.httpHealthy(applicationUrl, ownership)) {
                return Object.freeze({
                  safeCode: "FIRST_RELEASE_HEALTHY" as const,
                  evidenceHash: canonicalSha256({
                    schemaVersion: 1,
                    serviceArn: input.serviceArn,
                    taskDefinitionArn: input.taskDefinitionArn,
                    targetGroupArn: input.targetGroupArn,
                    containerPort: input.containerPort,
                    applicationUrl,
                  }),
                  applicationUrl,
                });
              }
              lastCode = "FIRST_RELEASE_APPLICATION_HEALTH_PENDING";
            } else {
              lastCode = "FIRST_RELEASE_TARGET_REGISTRATION_PENDING";
            }
          }
        }
        await this.delay(10_000, ownership);
      }
      throw new Error(lastCode === "FIRST_RELEASE_TARGET_UNHEALTHY"
        ? lastCode : "FIRST_RELEASE_HEALTH_VERIFICATION_TIMEOUT");
    } catch (error) {
      throw this.safeError(error);
    }
  }

  private async loadPinnedDockerfile(input: V1FirstReleaseImageBuildRequest) {
    if (input.dockerStrategy === "custom") return "";
    const rows = await this.dataSource.query(
      `SELECT contract_hash AS "contractHash", generated_dockerfile AS "dockerfile"
       FROM project_deployment_contracts WHERE project_id = $1 LIMIT 1`,
      [input.projectId],
    );
    const row = rows[0];
    if (row?.contractHash !== input.deploymentContractHash
      || typeof row.dockerfile !== "string"
      || !row.dockerfile.trim()
      || row.dockerfile.length > 128 * 1024) {
      throw new Error("FIRST_RELEASE_DOCKERFILE_CONTEXT_UNAVAILABLE");
    }
    return row.dockerfile;
  }

  private appDirectory(root: string, appRoot: string) {
    if (!APP_ROOT.test(appRoot)) throw new Error("FIRST_RELEASE_APP_ROOT_INVALID");
    const directory = resolve(root, appRoot || ".");
    if (relative(root, directory).startsWith("..")) throw new Error("FIRST_RELEASE_APP_ROOT_INVALID");
    return directory;
  }

  private assertBuildInput(input: V1FirstReleaseImageBuildRequest) {
    if (!input || !COMMIT.test(input.commitSha) || !ECR_REPOSITORY.test(input.repositoryUrl)
      || !REPOSITORY.test(input.repositoryFullName) || !APP_ROOT.test(input.appRoot)
      || !/^[0-9a-f]{64}$/.test(input.buildFingerprint)
      || !/^[0-9a-f]{64}$/.test(input.deploymentContractHash)
      || !["generated", "custom"].includes(input.dockerStrategy)) {
      throw new Error("FIRST_RELEASE_BUILD_CONTRACT_INVALID");
    }
  }

  private async command(command: string, args: string[], ownership: V1HandlerSideEffectExecutorContext, timeout = 60_000) {
    this.assertTrusted(ownership);
    const result = await execFile(command, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      signal: ownership.signal,
    });
    this.assertTrusted(ownership);
    return result;
  }

  private async loginDocker(region: string, ownership: V1HandlerSideEffectExecutorContext) {
    this.assertTrusted(ownership);
    const token = await this.ecr.send(new GetAuthorizationTokenCommand({}), { abortSignal: ownership.signal });
    this.assertTrusted(ownership);
    const auth = token.authorizationData?.length === 1 ? token.authorizationData[0] : null;
    if (!auth?.authorizationToken || !auth.proxyEndpoint) throw new Error("FIRST_RELEASE_ECR_AUTH_UNAVAILABLE");
    const [username, password] = Buffer.from(auth.authorizationToken, "base64").toString("utf8").split(":", 2);
    if (username !== "AWS" || !password) throw new Error("FIRST_RELEASE_ECR_AUTH_UNAVAILABLE");
    await new Promise<void>((resolveLogin, rejectLogin) => {
      const child = spawn("docker", ["login", "--username", username, "--password-stdin", auth.proxyEndpoint!], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let failed = false;
      child.once("error", () => { failed = true; rejectLogin(new Error("FIRST_RELEASE_ECR_LOGIN_FAILED")); });
      child.once("close", (code) => {
        if (!failed && code === 0) resolveLogin();
        else if (!failed) rejectLogin(new Error("FIRST_RELEASE_ECR_LOGIN_FAILED"));
      });
      child.stdin.end(password);
    });
    this.assertTrusted(ownership);
    void region;
  }

  private async httpHealthy(url: string, ownership: V1HandlerSideEffectExecutorContext) {
    this.assertTrusted(ownership);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const onAbort = () => controller.abort();
    ownership.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "DeployGuard-FirstReleaseHealth/1" },
      });
      this.assertTrusted(ownership);
      return response.status >= 200 && response.status < 400;
    } catch {
      this.assertTrusted(ownership);
      return false;
    } finally {
      clearTimeout(timeout);
      ownership.signal.removeEventListener("abort", onAbort);
    }
  }

  private async delay(ms: number, ownership: V1HandlerSideEffectExecutorContext) {
    this.assertTrusted(ownership);
    await new Promise<void>((resolveDelay, rejectDelay) => {
      const timer = setTimeout(resolveDelay, ms);
      const onAbort = () => {
        clearTimeout(timer);
        rejectDelay(new Error("FIRST_RELEASE_OWNERSHIP_LOST"));
      };
      ownership.signal.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
    this.assertTrusted(ownership);
  }

  private assertTrusted(ownership: V1HandlerSideEffectExecutorContext) {
    if (ownership.signal.aborted || !ownership.isLeaseTrusted()) {
      throw new Error("FIRST_RELEASE_OWNERSHIP_LOST");
    }
  }

  private safeError(error: unknown) {
    const code = error instanceof Error ? error.message : "FIRST_RELEASE_EXTERNAL_OPERATION_FAILED";
    return new Error(/^[A-Z0-9_]{3,128}$/.test(code)
      ? code
      : "FIRST_RELEASE_EXTERNAL_OPERATION_FAILED");
  }
}
