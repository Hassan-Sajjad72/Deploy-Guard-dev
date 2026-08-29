import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ServiceUnavailableException } from "@nestjs/common";
import { SnsNotificationAdapter } from "../src/notifications/sns-notification.adapter";
import { ObservabilityService } from "../src/observability/observability.service";
import { LiveRuntimeResolverService } from "../src/observability/live-runtime-resolver.service";
import { ProjectDeletionService } from "../src/projects/project-deletion.service";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const projectId = "11111111-2222-4333-8444-555555555555";
const generationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const operationId = "99999999-8888-4777-8666-555555555555";
const topicArn = `arn:aws:sns:us-east-1:123456789012:deployguard-${projectId}-notifications`;

function snsHarness(unsubscribeError: Error | null) {
  const adapter: any = new SnsNotificationAdapter({
    get: (key: string, fallback?: unknown) => ({
      NOTIFICATION_DELIVERY_ENABLED: "true",
      AWS_ACCESS_KEY_ID: "certification-access-key",
      AWS_SECRET_ACCESS_KEY: "certification-secret-key",
    } as Record<string, string>)[key] ?? fallback,
  } as never);
  const calls: string[] = [];
  adapter.client = () => ({
    send: async (command: { constructor: { name: string } }) => {
      calls.push(command.constructor.name);
      if (command.constructor.name === "UnsubscribeCommand" && unsubscribeError) throw unsubscribeError;
      if (command.constructor.name === "ListTagsForResourceCommand") return {
        Tags: [
          { Key: "ManagedBy", Value: "DeployGuard" },
          { Key: "DeployGuardProjectId", Value: projectId },
        ],
      };
      if (command.constructor.name === "GetTopicAttributesCommand") {
        const error = new Error("topic absent") as Error & { name: string };
        error.name = "NotFoundException";
        throw error;
      }
      return {};
    },
  });
  return { adapter, calls };
}

function verifiedDestroy(): any {
  return {
    id: operationId,
    projectId,
    generationId,
    status: PipelineRunStatus.COMPLETED,
    metadata: {
      deploymentAction: "destroy",
      destroyVerification: {
        contractVersion: "deployguard.destroy-result/v2",
        status: "project_delete_ready",
        deploymentOperationId: operationId,
        projectId,
        environmentName: "dev",
        generationIds: [generationId],
        generationResourcesRemoved: true,
        projectResourcesRemoved: true,
        terraformStateArtifactsRemoved: true,
        sharedPlatformUntouched: true,
      },
    },
  };
}

async function run() {
  const pending = snsHarness(Object.assign(new Error("Cannot unsubscribe a subscription that is pending confirmation"), { name: "InvalidParameterException" }));
  await pending.adapter.deleteProjectResources(projectId, [{ providerSubscriptionArn: "arn:aws:sns:us-east-1:123456789012:topic:subscription", providerTopicArn: topicArn }]);
  assert.ok(pending.calls.includes("DeleteTopicCommand"), "a remotely pending confirmation cannot block owned topic deletion");

  const absent = snsHarness(Object.assign(new Error("subscription absent"), { name: "NotFoundException" }));
  await absent.adapter.deleteProjectResources(projectId, [{ providerSubscriptionArn: "arn:aws:sns:us-east-1:123456789012:topic:subscription", providerTopicArn: topicArn }]);
  assert.ok(absent.calls.includes("DeleteTopicCommand"), "an already-absent subscription is idempotent during project deletion");

  const unexpected = snsHarness(Object.assign(new Error("Access denied"), { name: "AuthorizationErrorException" }));
  await assert.rejects(
    unexpected.adapter.deleteProjectResources(projectId, [{ providerSubscriptionArn: "arn:aws:sns:us-east-1:123456789012:topic:subscription", providerTopicArn: topicArn }]),
    /Access denied/,
    "unexpected SNS errors remain fail-closed",
  );

  const deletion: any = Object.create(ProjectDeletionService.prototype);
  deletion.subscriptions = { find: async () => [{ providerSubscriptionArn: "PendingConfirmation", providerTopicArn: topicArn }] };
  deletion.projects = { count: async () => 1 };
  deletion.sns = { deleteProjectResources: async () => undefined };
  deletion.githubApp = { removeManagedWorkflow: async () => { throw new Error("shared caller must not be deleted"); } };
  deletion.dataSource = {
    transaction: async (work: (manager: any) => Promise<unknown>) => work({
      query: async () => undefined,
      getRepository: () => ({
        findOne: async () => verifiedDestroy(),
        delete: async () => ({ affected: 1 }),
      }),
    }),
  };
  const cleanupFailedVerifiedDestroy = {
    ...verifiedDestroy(),
    status: PipelineRunStatus.FAILED,
    currentStage: "project_delete_cleanup",
    metadata: { ...verifiedDestroy().metadata, failureCategory: "project_delete_incomplete" },
  };
  const finalized = await deletion.finalize({ id: projectId, repositoryFullName: "owner/repo", targetBranch: "main", ownerUserId: 1, githubInstallationId: null }, cleanupFailedVerifiedDestroy);
  assert.deepEqual(finalized, { projectId, status: "deleted" }, "a retry after verified AWS deletion resumes remaining control-plane cleanup only");

  const project: any = { id: projectId, repositoryFullName: "owner/repo", targetBranch: "main", ownerUserId: 1, githubInstallationId: null };
  const attemptFour: any = cleanupFailedVerifiedDestroy;
  const attemptFive: any = {
    ...verifiedDestroy(), id: "88888888-7777-4666-8555-444444444444", status: PipelineRunStatus.FAILED, currentStage: "workflow_dispatch",
    metadata: { ...attemptFour.metadata, retryOfOperationId: attemptFour.id },
  };
  const attemptSix: any = {
    ...verifiedDestroy(), id: "77777777-6666-4555-8444-333333333333", status: PipelineRunStatus.FAILED, currentStage: "set_up_job",
    metadata: { ...attemptFive.metadata, retryOfOperationId: attemptFive.id },
  };
  const retryService: any = Object.create(GithubActionsDeploymentService.prototype);
  retryService.project = async () => project;
  retryService.withProjectLock = async (_id: string, work: (repository: any) => Promise<unknown>) => work({
    findOne: async ({ where }: { where: { id: string } }) => ({ [attemptFour.id]: attemptFour, [attemptFive.id]: attemptFive })[where.id] || null,
  });
  retryService.reconcileActive = async () => null;
  retryService.latestRun = async () => attemptSix;
  let finalizedAncestor: any = null;
  retryService.projectDeletion = { finalize: async (_project: any, ancestor: any) => { finalizedAncestor = ancestor; } };
  let redispatches = 0;
  retryService.redispatch = async () => { redispatches += 1; throw new Error("must not redispatch"); };
  retryService.result = (state: string, message: string, operation: any) => ({ deployment: { state, message, operation: { id: operation.id } } });
  const cleanupOnlyRetry = await retryService.retry({ id: 1 }, projectId);
  assert.equal(cleanupOnlyRetry.deployment.state, "no_op");
  assert.equal(finalizedAncestor.id, attemptFour.id, "control-plane retry uses the original immutable verification operation");
  assert.equal(redispatches, 0, "verified deletion retry never dispatches GitHub Actions, Terraform, or AWS Destroy");

  const ordinaryFailedDestroy: any = { ...attemptSix, metadata: { deploymentAction: "destroy" } };
  retryService.latestRun = async () => ordinaryFailedDestroy;
  retryService.deploymentGenerations = { requireActiveGeneration: async () => ({ id: generationId }) };
  retryService.redispatch = async () => { redispatches += 1; return { deployment: { state: "accepted", message: "full destroy", operation: { id: "new-operation" } } }; };
  const fullRetry = await retryService.retry({ id: 1 }, projectId);
  assert.equal(fullRetry.deployment.state, "accepted");
  assert.equal(redispatches, 1, "Destroy without verified evidence preserves the full retry workflow");

  const release: any = {
    id: "release-id", projectId, environmentName: "dev", generationId,
    ecsServiceArn: "service-arn", taskDefinitionArn: "task-definition-arn",
    metadata: { targetGroupArn: "target-group-arn" },
  };
  const resolver: any = new LiveRuntimeResolverService(
    {} as never,
    { findOne: async () => ({ id: generationId }) } as never,
    { findOne: async () => release } as never,
    { get: (key: string, fallback?: string) => key === "DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME" ? "shared" : fallback } as never,
  );
  resolver.ecs = () => ({ send: async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "DescribeServicesCommand") return { services: [{ serviceArn: "service-arn", status: "ACTIVE", taskDefinition: "task-definition-arn" }] };
    if (command.constructor.name === "DescribeTaskDefinitionCommand") return { taskDefinition: { containerDefinitions: [{ name: "app", logConfiguration: { options: { "awslogs-group": `/deployguard/${projectId}/dev/${generationId}/app` } } }] } };
    return { taskArns: [] };
  } });
  resolver.elb = () => ({ send: async (command: { constructor: { name: string } }) => {
    const error = new Error("target group absent") as Error & { name: string };
    error.name = "TargetGroupNotFoundException";
    if (command.constructor.name === "DescribeTargetGroupsCommand" || command.constructor.name === "DescribeTargetHealthCommand") throw error;
    return {};
  } });
  await assert.rejects(
    resolver.resolveProject({ id: projectId, targetEnvironment: "dev" }),
    (error: unknown) => error instanceof ServiceUnavailableException && /no longer present/i.test(error.message),
    "missing target groups are converted to bounded runtime-unavailable state",
  );

  resolver.elb = () => ({ send: async (command: { constructor: { name: string } }) =>
    command.constructor.name === "DescribeTargetGroupsCommand"
      ? { TargetGroups: [{ TargetGroupArn: "target-group-arn", LoadBalancerArns: ["load-balancer-arn"] }] }
      : { TargetHealthDescriptions: [] },
  });
  resolver.ecs = () => ({ send: async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "DescribeServicesCommand") return { services: [{ serviceArn: "service-arn", status: "INACTIVE", taskDefinition: "task-definition-arn" }] };
    if (command.constructor.name === "DescribeTaskDefinitionCommand") return { taskDefinition: { containerDefinitions: [] } };
    return { taskArns: [] };
  } });
  await assert.rejects(
    resolver.resolveProject({ id: projectId, targetEnvironment: "dev" }),
    (error: unknown) => error instanceof ServiceUnavailableException && /does not match/i.test(error.message),
    "an inactive ECS service is bounded as unavailable rather than treated as a LIVE runtime",
  );

  const observability = new ObservabilityService(
    { get: (_key: string, fallback?: unknown) => fallback } as never,
    { resolveForUser: async () => { throw new ServiceUnavailableException("The previously authoritative LIVE runtime is no longer present in AWS."); } } as never,
    {} as never,
    {} as never,
  );
  assert.deepEqual(
    await observability.getApplicationMetrics({} as never, projectId),
    { available: false, message: "The previously authoritative LIVE runtime is no longer present in AWS.", generationId: null },
    "expected runtime absence returns an unavailable metrics response instead of an uncaught AWS SDK error",
  );

  console.log("Destroy finalization resilience passed: idempotent SNS cleanup, retryable control-plane finalization, and bounded missing-runtime observability.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
