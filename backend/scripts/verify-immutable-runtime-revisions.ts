import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { assertRailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure/railpack-runtime/main.tf"), "utf8");
const terraformOutputs = readFileSync(join(root, "infrastructure/railpack-runtime/outputs.tf"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const deployment = readFileSync(join(root, "backend/src/projects/railpack-deployment.service.ts"), "utf8");
const projection = readFileSync(join(root, "backend/src/projects/stable-release-projection.ts"), "utf8");
const migration = readFileSync(join(root, "backend/src/migrations/1787356814000-ImmutableServiceRevisions.ts"), "utf8");
const deletionMigration = readFileSync(join(root, "backend/src/migrations/1787356815000-ServiceRevisionDeletionSemantics.ts"), "utf8");
const projectsService = readFileSync(join(root, "backend/src/projects/projects.service.ts"), "utf8");

const projectId = "11111111-1111-4111-8111-111111111111";
const generationA = "22222222-2222-4222-8222-222222222222";
const operationA = "33333333-3333-4333-8333-333333333333";
const rollbackOperation = "44444444-4444-4444-8444-444444444444";
const serviceIds = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
const configIds = ["77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"];
const versionA = "a".repeat(64);
const sourceA = "b".repeat(40);
const immutableRefA = `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/a:TOKEN::${versionA}`;
const revisions = serviceIds.map((serviceId, index) => ({
  serviceId,
  serviceName: index ? "Worker" : "Web",
  serviceDirectory: index ? "worker" : "web",
  imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/service-${index}`,
  imageDigest: `sha256:${String(index + 1).repeat(64)}`,
  runtimeConfigRevisionId: configIds[index],
  runtimeConfigRevision: {
    id: configIds[index], projectId, serviceId, isRollbackSafe: true, sealedAt: new Date(),
    nonSecretEnvironment: { PORT: "8080", HOST: "0.0.0.0", RELEASE: "A" },
    secretReferences: index ? {} : { TOKEN: immutableRefA },
    databaseConfiguration: index ? { attached: false, engine: null, aliases: [] } : { attached: true, engine: "postgres", aliases: ["DATABASE_URL"], secretVersionId: versionA },
  },
}));

void (async () => {
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.serviceRevisions = { find: async () => [...revisions].reverse() };
  const release = { id: "99999999-9999-4999-8999-999999999999", generationId: generationA, deployedByPipelineRunId: operationA, commitSha: sourceA, metadata: { releaseEvidenceVerified: true } };
  const targetA = await service.rollbackTarget(release);
  assert.deepEqual(targetA.services.map((item: any) => item.serviceId), [...serviceIds].sort(), "service order must not affect rollback identity");
  assert.equal(targetA.services.find((item: any) => item.serviceId === serviceIds[0]).runtimeConfiguration.environment.RELEASE, "A");
  assert.equal(targetA.services.find((item: any) => item.serviceId === serviceIds[0]).runtimeConfiguration.secretReferences.TOKEN, immutableRefA);
  assert.equal(targetA.services.find((item: any) => item.serviceId === serviceIds[0]).runtimeConfiguration.managedDatabase.secretVersionId, versionA);

  service.deployableServices = { find: async () => { throw new Error("current services must not be read by rollback"); } };
  service.variables = { createQueryBuilder: () => { throw new Error("current ENV must not be read by rollback"); } };
  service.databaseTiers = { findOne: async () => { throw new Error("current database attachment must not be read by rollback"); } };
  service.dataSource = { getRepository: () => ({ find: async () => [] }) };
  const restored = await service.runtimeConfiguration({ id: projectId }, "dev", rollbackOperation, sourceA, "rollback", targetA);
  assertRailpackRuntimeConfiguration(restored);
  const restoredWeb = restored.services.find((item: any) => item.serviceId === serviceIds[0]);
  assert.equal(restoredWeb.rollbackImage, `${revisions[0].imageUri}@${revisions[0].imageDigest}`, "rollback restores image A");
  assert.equal(restoredWeb.environment.RELEASE, "A", "rollback restores config A");
  assert.equal(restoredWeb.secretReferences.TOKEN, immutableRefA, "rollback restores the exact secret version from A");
  assert.doesNotMatch(workflow.match(/Select immutable rollback service images[\s\S]*?Install Terraform/)?.[0] || "", /railpack build/i);

  const applicationTask = terraform.match(/resource "aws_ecs_task_definition" "application" \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(applicationTask, /name\s*=\s*"database"|efs_volume_configuration/, "application task definitions contain no database sidecar or EFS volume");
  assert.match(terraform, /resource "aws_ecs_task_definition" "database"/);
  assert.match(terraform, /resource "aws_ecs_service" "database"/);
  assert.match(terraform, /aws_security_group\.application\[local\.database_service_id\]\.id/, "only the attached application security group can reach the database");
  assert.match(terraform, /aws_security_group\.database_efs[\s\S]*aws_security_group\.database_runtime/, "only the independent database runtime reaches EFS");
  assert.match(terraformOutputs, /secret_version_id\s*=\s*aws_secretsmanager_secret_version\.database\[0\]\.version_id/);
  assert.match(workflow, /DG_DATABASE_SECRET_VERSION_MISMATCH/);

  assert.doesNotMatch(deployment, /services\[0\]/);
  assert.doesNotMatch(projection, /input\.(imageUri|taskDefinitionArn|ecsServiceArn)/);
  assert.match(deployment, /ProjectGenerationServiceRevision/);
  assert.match(deployment, /runtimeConfigRevisionId/);
  assert.match(migration, /project_service_runtime_config_revisions/);
  assert.match(migration, /project_generation_service_revisions/);
  assert.match(migration, /is_rollback_safe[\s\S]*false[\s\S]*legacy_backfill/);
  assert.match(deletionMigration, /ON DELETE CASCADE/);
  assert.match(projectsService, /getRepository\(ProjectGenerationServiceRevision\)\.exist[\s\S]*immutable release history cannot be removed/);
  console.log("IMMUTABLE_RUNTIME_REVISIONS=PASS IMAGE_A_CONFIG_A=1 SECRET_VERSION_PINNED=1 DATABASE_INDEPENDENT=1 SERVICE_ORDER_AUTHORITY=0");
})().catch((error) => { console.error(error); process.exitCode = 1; });
