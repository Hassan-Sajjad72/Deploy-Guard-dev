import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { RepairGenerationScopedStableReleaseIndex1760000066000 } from "../src/migrations/1760000066000-RepairGenerationScopedStableReleaseIndex";
import { ProjectStableRelease } from "../src/orchestration/project-stable-release.entity";
import {
  RuntimeEvidenceContractError,
  validateGithubActionsRuntimeEvidence,
} from "../src/projects/github-actions-release-evidence";
import { materializeStableRelease, StableReleaseProjectionInput } from "../src/projects/stable-release-projection";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const driftSchema = `stable_release_drift_${suffix}`;
const correctSchema = `stable_release_correct_${suffix}`;
for (const value of [driftSchema, correctSchema]) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Unsafe isolated schema name.");
}

const tableSql = (schema: string) => `
  CREATE TABLE "${schema}"."project_stable_releases" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    generation_id uuid NULL,
    release_manifest_id uuid NULL,
    environment_name varchar NOT NULL DEFAULT 'dev',
    commit_sha varchar NOT NULL,
    short_commit_sha varchar NOT NULL,
    image_uri varchar NOT NULL,
    task_definition_arn varchar NOT NULL,
    ecs_service_arn varchar NULL,
    health_check_path varchar NOT NULL DEFAULT '/health',
    app_port integer NULL,
    deployed_by_pipeline_run_id uuid NULL,
    deployed_at timestamptz NOT NULL,
    status varchar NOT NULL DEFAULT 'stable',
    metadata jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

function input(projectId: string, generationId: string, operationId: string, commit: string): StableReleaseProjectionInput {
  return {
    projectId,
    generationId,
    environmentName: "dev",
    operationId,
    commitSha: commit,
    imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:${"a".repeat(64)}`,
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/app:1",
    ecsServiceArn: `arn:aws:ecs:us-east-1:123456789012:service/deployguard-shared/${generationId}`,
    healthCheckPath: "/health",
    appPort: 8000,
    metadata: { operationId },
  };
}

async function indexDefinition(dataSource: DataSource, schema: string) {
  return dataSource.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'UQ_project_stable_release_scope'`,
    [schema],
  ).then((rows) => String(rows[0]?.indexdef || ""));
}

async function runMigration(dataSource: DataSource, schema: string) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`SET search_path TO "${schema}", public`);
    await new RepairGenerationScopedStableReleaseIndex1760000066000().up(runner);
  } finally {
    await runner.release();
  }
}

async function main() {
  await AppDataSource.initialize();
  try {
    await AppDataSource.query(`CREATE SCHEMA "${driftSchema}"`);
    await AppDataSource.query(`CREATE SCHEMA "${correctSchema}"`);
    await AppDataSource.query(tableSql(driftSchema));
    await AppDataSource.query(tableSql(correctSchema));
    await AppDataSource.query(`CREATE UNIQUE INDEX "UQ_project_stable_release_scope" ON "${driftSchema}"."project_stable_releases" (project_id, environment_name) WHERE status = 'stable'`);
    await AppDataSource.query(`CREATE UNIQUE INDEX "UQ_project_stable_release_scope" ON "${correctSchema}"."project_stable_releases" (project_id, environment_name, generation_id) WHERE status = 'stable'`);

    const projectId = randomUUID();
    const legacyId = randomUUID();
    await AppDataSource.query(
      `INSERT INTO "${driftSchema}".project_stable_releases (id,project_id,generation_id,commit_sha,short_commit_sha,image_uri,task_definition_arn,deployed_at,status) VALUES ($1,$2,NULL,$3,$4,$5,$6,now(),'stable')`,
      [legacyId, projectId, "1".repeat(40), "1".repeat(12), "legacy", "legacy:1"],
    );

    await runMigration(AppDataSource, driftSchema);
    await runMigration(AppDataSource, correctSchema);
    for (const schema of [driftSchema, correctSchema]) {
      const definition = await indexDefinition(AppDataSource, schema);
      assert.match(definition, /\(project_id, environment_name, generation_id\)/);
      assert.match(definition, /status.*stable/i);
    }

    const scoped = new DataSource({
      ...AppDataSource.options,
      schema: driftSchema,
      migrations: [],
      synchronize: false,
      logging: false,
    } as DataSourceOptions);
    await scoped.initialize();
    try {
      const generation1 = randomUUID();
      const generation2 = randomUUID();
      const generation3 = randomUUID();
      const firstOperation = randomUUID();
      const first = await scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation2, firstOperation, "2".repeat(40))));
      assert.ok(first.id);
      assert.equal(first.generationId, generation2, "legacy NULL generation must not block active Generation 2");

      const historical = await scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation1, randomUUID(), "3".repeat(40))));
      assert.equal(historical.generationId, generation1, "retired-generation history remains isolated");

      const replay = await scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation2, firstOperation, "2".repeat(40))));
      assert.equal(replay.id, first.id, "same operation reuses the immutable release");

      const concurrentOperation = randomUUID();
      const [left, right] = await Promise.all([
        scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation2, concurrentOperation, "4".repeat(40)))),
        scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation2, concurrentOperation, "4".repeat(40)))),
      ]);
      assert.equal(left.id, right.id, "concurrent reconciliation resolves to one release");

      const later = await scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation2, randomUUID(), "5".repeat(40))));
      const generation2Rows = await scoped.getRepository(ProjectStableRelease).find({ where: { projectId, generationId: generation2 } });
      assert.equal(generation2Rows.filter((row) => row.status === "stable").length, 1);
      assert.equal(generation2Rows.find((row) => row.id === later.id)?.status, "stable");
      assert.ok(generation2Rows.every((row) => row.id === later.id || row.status === "rollback_target"));

      const isolated = await scoped.transaction((manager) => materializeStableRelease(manager, input(projectId, generation3, randomUUID(), "6".repeat(40))));
      assert.equal(isolated.generationId, generation3);
      assert.equal(await scoped.getRepository(ProjectStableRelease).count({ where: { deployedByPipelineRunId: concurrentOperation } }), 1);
      assert.equal(await scoped.getRepository(ProjectStableRelease).count({ where: { id: legacyId, generationId: null } }), 1);
    } finally {
      await scoped.destroy();
    }

    const evidence = {
      contractVersion: "deployguard.deployment-result/v2" as const,
      deploymentOperationId: randomUUID(), commitSha: "a".repeat(40), environmentName: "dev",
      generationId: randomUUID(),
      imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:${"b".repeat(64)}`,
      imageDigest: `sha256:${"b".repeat(64)}`, taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/app:1",
      clusterName: "app", serviceName: "app", appPort: 8000, healthCheckPath: "/health",
      ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/deployguard-shared/app",
      targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/app/1234567890abcdef",
      listenerRuleArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener-rule/app/123/456/789",
      routingVerified: true as const,
      promotionIntentFingerprint: "e".repeat(64),
      configurationFingerprint: "c".repeat(64), configurationSnapshotId: randomUUID(), databaseBindingId: null,
      secretReferenceNames: [], databaseOutputs: {},
    };
    const expected = {
      deploymentOperationId: evidence.deploymentOperationId!, generationId: evidence.generationId, commitSha: evidence.commitSha, environmentName: "dev",
      configurationSnapshotId: evidence.configurationSnapshotId, configurationFingerprint: evidence.configurationFingerprint,
      databaseBindingId: null, runtimeDatabaseBindingId: null, secretReferenceNames: [],
      promotionIntentFingerprint: "e".repeat(64),
    };
    assert.deepEqual(validateGithubActionsRuntimeEvidence(evidence, expected), []);
    assert.deepEqual(validateGithubActionsRuntimeEvidence({ ...evidence, commitSha: "d".repeat(40) }, expected), [{ field: "commitSha", reason: "mismatched" }]);
    assert.ok(new RuntimeEvidenceContractError([{ field: "commitSha", reason: "mismatched" }]) instanceof RuntimeEvidenceContractError);

    const source = readFileSync(resolve(process.cwd(), "src/projects/github-actions-deployment.service.ts"), "utf8");
    assert.match(source, /failureCategory: "stable_release_persistence"/);
    assert.match(source, /failureCategory: "runtime_evidence_contract"/);
    assert.match(source, /github-actions-reconcile:\$\{operation\.id\}/);
    assert.match(source, /MAX_STABLE_RELEASE_RECONCILIATION_ATTEMPTS = 3/);
    const finalization = source.slice(source.indexOf("const stableRelease = await materializeStableRelease"), source.indexOf("private async verifyAndReconcileRollbackStableRelease"));
    assert.ok(finalization.indexOf("await this.deploymentGenerations.promoteVerified") > finalization.indexOf("const stableRelease = await materializeStableRelease"));
    assert.ok(finalization.indexOf("return stableRelease") > finalization.indexOf("await this.deploymentGenerations.promoteVerified"), "stable projection and generation/route promotion must commit in the same transaction");
  } finally {
    await AppDataSource.query(`DROP SCHEMA IF EXISTS "${driftSchema}" CASCADE`);
    await AppDataSource.query(`DROP SCHEMA IF EXISTS "${correctSchema}" CASCADE`);
    await AppDataSource.destroy();
  }
}

main().then(() => {
  console.log("Stable-release ingestion checks passed: drift repair, clean-schema parity, generation isolation, idempotency, concurrency serialization, release transition, and evidence classification.");
}).catch((error) => { console.error(error); process.exitCode = 1; });
