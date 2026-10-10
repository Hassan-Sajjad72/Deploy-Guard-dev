import { createHash, randomUUID } from "node:crypto";
import { AwsOwnershipJournal, AWS_RESOURCE_OWNERSHIP_SOURCE, freezeDestroyOwnership, OWNERSHIP_FAMILIES, ownershipSha256 } from "../../src/projects/aws-resource-ownership";

/** Simulated ownership/absence, never a claim of real AWS verification. */
export function destroyProofFixture(projectId: string, operationId: string, generationIds: string[], verifiedAt = new Date().toISOString()) {
  const scope = { projectId, operationId, environmentName: "dev", accountId: "123456789012", region: "us-east-1", generationIds };
  const operations = generationIds.map((id) => ({ id, projectId, commitSha: "a".repeat(40), metadata: { executionEngine: "railpack", deploymentAction: "deploy" } }));
  const retainedGenerations = generationIds.map((id, index) => ({ id, projectId, environmentName: "dev", createdByOperationId: operations[index].id }));
  const serviceId = "60000000-0000-4000-8000-000000000006";
  const cluster = `arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-${projectId}`;
  const serviceArn = `arn:aws:ecs:us-east-1:123456789012:service/deployguard-${projectId}/application`;
  const albArn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/fixture/1234567890abcdef";
  const targetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fixture/1234567890abcdef";
  const logGroup = `/deployguard/${projectId}/services/${serviceId}`;
  const configurations = operations.map((op) => ({ id: randomUUID(), projectId, serviceId, createdByOperationId: op.id, environmentName: "dev",
    configurationFingerprint: "c".repeat(64), secretReferences: {}, databaseConfiguration: { attached: false }, sealedAt: new Date() }));
  const revisions = generationIds.map((id, index) => ({ projectId, generationId: id, serviceId, serviceName: "Web", serviceDirectory: ".", sourceSha: "a".repeat(40),
    imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-${projectId}`, imageDigest: `sha256:${"b".repeat(64)}`, runtimeConfigRevisionId: configurations[index].id,
    runtimeIdentity: { taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-${projectId}:${index + 1}`, ecsServiceArn: serviceArn, albArn, targetGroupArn, cloudWatchLogGroupName: logGroup } }));
  const journals: AwsOwnershipJournal[] = operations.map((op, index) => ({ contractVersion: "deployguard.aws-resource-ownership/v1", scope: { projectId, operationId: op.id, environmentName: scope.environmentName, accountId: scope.accountId, region: scope.region },
    sourceSha: op.commitSha, coverage: [...OWNERSHIP_FAMILIES], unresolvedIntents: [], resources: [
      { type: "aws_ecs_cluster", id: cluster },
      { type: "aws_ecs_service", id: serviceArn, parent: cluster },
      { type: "aws_ecs_task_definition", id: revisions[index].runtimeIdentity.taskDefinitionArn },
      { type: "aws_ecr_repository", id: `deployguard-${projectId}` },
      { type: "aws_lb", id: albArn }, { type: "aws_lb_target_group", id: targetGroupArn }, { type: "aws_cloudwatch_log_group", id: logGroup },
    ] }));
  const events = journals.map((journal) => ({ projectId, pipelineRunId: journal.scope.operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE, metadata: { evidence: journal, sha256: ownershipSha256(journal) } }));
  const ownership = freezeDestroyOwnership(scope, operations, events, "m0-disposable-state");
  const evidence = { contractVersion: "deployguard.destroy-result/v3", deploymentOperationId: operationId, projectId, environmentName: "dev", generationIds: [...generationIds], status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true, terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, verifiedAt,
    ownershipSha256: ownershipSha256(ownership), observation: { contractVersion: "deployguard.aws-deletion-observation/v1", scope: ownership.manifest.scope,
      manifestSha256: createHash("sha256").update(JSON.stringify(ownership.manifest)).digest("hex"), status: "PASS", code: null, verifiedAt,
      observations: ownership.manifest.resources.map((r) => ({ ...r, status: "PASS", basis: r.type === "aws_ecs_task_definition" ? "inactive" : "absent", providerCode: r.type === "s3_state_object" ? "404" : r.type === "aws_ecr_repository" ? "RepositoryNotFoundException"
        : r.type === "aws_lb" ? "LoadBalancerNotFound" : r.type === "aws_lb_target_group" ? "TargetGroupNotFound" : r.type === "aws_ecs_service" ? "ClusterNotFoundException" : null, attempts: 1 })) } };
  const inputs = { aws_region: scope.region, aws_role_arn: `arn:aws:iam::${scope.accountId}:role/m0-disposable`, terraform_state_bucket: "m0-disposable-state" };
  return { ownership, evidence, inputs, events, operations, journals, revisions, configurations, retainedGenerations };
}
