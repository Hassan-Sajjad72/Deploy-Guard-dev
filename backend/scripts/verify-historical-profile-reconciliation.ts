import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import "dotenv/config";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const projectId = "620f00cc-89e8-4376-83e3-42e3a19a602e";
const profileId = "52271c17-0bc2-4930-9f72-71f963230777";

function operation(id: string, detectionProfileId: string | null) {
  return {
    id,
    projectId,
    detectionProfileId,
    githubWorkflowRunId: "123456789",
    githubWorkflowStatus: "completed",
    status: PipelineRunStatus.COMPLETED,
    currentStage: "destroyed",
    startedAt: new Date("2026-08-18T10:00:00Z"),
    currentStageStartedAt: null,
    completedAt: new Date("2026-08-18T10:05:00Z"),
    failedAt: null,
    errorMessage: null,
    createdAt: new Date("2026-08-18T10:00:00Z"),
    metadata: {
      executionEngine: "github_actions",
      deploymentAction: "destroy",
      conclusion: "success",
      immutableDispatchInputs: { detection_profile_version: "topology-detection-v2" },
    },
  } as any;
}

async function schemaCheck() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const column = await client.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='project_pipeline_runs' AND column_name='detection_profile_id'`);
    assert.equal(column.rows[0]?.is_nullable, "YES");
    const foreignKey = await client.query(`SELECT pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid='public.project_pipeline_runs'::regclass
        AND constraint_row.contype='f'
        AND pg_get_constraintdef(constraint_row.oid) ILIKE '%detection_profile_id%'`);
    assert.equal(foreignKey.rows.length, 1);
    assert.match(foreignKey.rows[0].definition, /ON DELETE SET NULL/);
  } finally {
    await client.end();
  }
}

async function reconciliationChecks() {
  const profiles = new Set([profileId]);
  const rows = new Map<string, any>();
  const updates: any[] = [];
  let profileCreates = 0;
  const runRepository: any = {
    update: async ({ id, projectId: expectedProject }: any, patch: any) => {
      updates.push({ id, patch });
      const current = rows.get(id);
      if (!current || current.projectId !== expectedProject) return { affected: 0 };
      Object.assign(current, patch);
      return { affected: 1 };
    },
    createQueryBuilder: () => ({
      where() { return this; }, andWhere() { return this; }, orderBy() { return this; },
      getMany: async () => [...rows.values()],
    }),
  };
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  service.runs = runRepository;
  service.profiles = {
    findOne: async ({ where }: any) => profiles.has(where.id) ? { id: where.id } : null,
    create: () => { profileCreates += 1; throw new Error("reconciliation must not create profiles"); },
  };
  service.project = async () => ({ id: projectId });
  service.response = (run: any) => ({ id: run.id, status: run.status, currentStage: run.currentStage, detectionProfileId: run.detectionProfileId, metadata: run.metadata });
  service.workflowStages = async () => [];

  const current = operation("11111111-1111-4111-8111-111111111111", profileId);
  rows.set(current.id, current);
  await service.persistReconciledOperation(current);
  assert.equal(rows.get(current.id).detectionProfileId, profileId, "an existing current profile remains normally referenced");

  const stale = operation("22222222-2222-4222-8222-222222222222", profileId);
  rows.set(stale.id, stale);
  profiles.delete(profileId);
  await service.persistReconciledOperation(stale);
  await service.persistReconciledOperation(stale);
  const persisted = rows.get(stale.id);
  assert.equal(persisted.detectionProfileId, null);
  assert.equal(persisted.status, PipelineRunStatus.COMPLETED);
  assert.equal(persisted.currentStage, "destroyed");
  assert.deepEqual(persisted.metadata.historicalDetectionProfile, { id: profileId, version: "topology-detection-v2" });
  assert.equal(profileCreates, 0, "no fake detection profile is recreated");

  const history = await service.history({ id: 1 }, projectId);
  assert.equal(history.operations.some((run: any) => run.id === stale.id && run.currentStage === "destroyed"), true,
    "historical Destroy remains visible and DESTROYED after profile removal");

  const concurrentlyDeleted = operation("33333333-3333-4333-8333-333333333333", profileId);
  await service.persistReconciledOperation(concurrentlyDeleted);
  assert.equal(rows.has(concurrentlyDeleted.id), false, "update-only reconciliation never reconstructs a deleted pipeline row");
  assert.ok(updates.length >= 4, "repeated reconciliation remains an idempotent update path");
  assert.equal(service.actions, undefined, "historical persistence correction dispatches no GitHub or AWS operation");
}

function sourceChecks() {
  const root = resolve(__dirname, "../..");
  const deletion = readFileSync(resolve(root, "backend/src/projects/project-deletion.service.ts"), "utf8");
  const profileEntity = readFileSync(resolve(root, "backend/src/projects/project-detection-profile.entity.ts"), "utf8");
  const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
  assert.match(profileEntity, /ManyToOne\(\(\) => Project, \{ nullable: false, onDelete: "CASCADE" \}\)/,
    "successful full project deletion is the proven profile-removal path");
  assert.match(deletion, /getRepository\(Project\)\.delete\(\{ id: project\.id \}\)/);
  const reconciliation = deployment.match(/private async persistReconciledOperation[\s\S]*?private async reconcileLocked/)?.[0] || "";
  assert.match(reconciliation, /this\.runs\.update/);
  assert.doesNotMatch(reconciliation, /this\.runs\.save|this\.profiles\.save|this\.profiles\.create/);
}

async function main() {
  await schemaCheck();
  await reconciliationChecks();
  sourceChecks();
  console.log("Historical detection-profile reconciliation passed: nullable SET NULL FK, immutable metadata retention, DESTROYED history, idempotent update-only persistence, and zero dispatch.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
