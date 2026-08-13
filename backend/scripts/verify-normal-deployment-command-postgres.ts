import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { User, UserRole } from "../src/users/user.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../src/projects/project.entity";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { NormalDeploymentCommandService } from "../src/projects/normal-deployment-command.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { decideAutomaticInfrastructurePolicy } from "../src/projects/normal-deployment-cost-policy";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const databaseName = `normal_deploy_command_${suffix}`;
if (!/^[a-z0-9_]+$/.test(databaseName) || databaseName === String(AppDataSource.options.database)) {
  throw new Error("Unsafe disposable database name.");
}

function options(database: string): DataSourceOptions {
  return { ...AppDataSource.options, database, migrations: [], logging: false } as DataSourceOptions;
}

function fixedConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => key in values ? values[key] : fallback,
  } as ConfigService;
}

async function run() {
  const admin = new DataSource(options(String(AppDataSource.options.database)));
  let fixture: DataSource | null = null;
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    fixture = new DataSource({ ...options(databaseName), synchronize: true } as DataSourceOptions);
    await fixture.initialize();
    const user = await fixture.getRepository(User).save({
      githubId: `normal-command-${suffix}`,
      name: "Normal command owner",
      email: `normal-command-${suffix}@example.invalid`,
      passwordHash: null,
      image: null,
      githubLogin: null,
      githubAccessToken: null,
      lastLoginAt: null,
      role: UserRole.DEVELOPER,
    });
    const projectId = randomUUID();
    await fixture.getRepository(Project).save({
      id: projectId,
      ownerUserId: user.id,
      name: "Disposable automatic deployment",
      description: null,
      repositoryUrl: "https://example.invalid/deployguard/disposable",
      repositoryProvider: "github",
      githubRepositoryId: null,
      repositoryFullName: "deployguard/disposable",
      targetBranch: "main",
      environmentName: "dev",
      appDirectory: ".",
      deploymentOverrides: {},
      status: ProjectStatus.CONFIGURED,
      visibility: ProjectVisibility.PRIVATE,
      archivedAt: null,
      deletionFenceToken: null,
      deletionIntentId: null,
      deletionStartedAt: null,
    });
    const intent = await fixture.getRepository(DeploymentIntent).save({
      schemaVersion: 1,
      projectId,
      environmentName: "dev",
      requestedByUserId: user.id,
      kind: "deploy",
      classification: "release_only",
      status: "planned",
      clientIdempotencyKey: `normal-command-${suffix}`,
      canonicalIdempotencyKey: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      requestPayload: {},
      decision: null,
      infrastructureManifestId: null,
      releaseManifestId: null,
      sourcePipelineRunId: null,
      pipelineRunId: null,
      destroyOperationId: null,
      failureCode: null,
      failureMessage: null,
      receivedAt: new Date(),
      plannedAt: new Date(),
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
    });
    const config = fixedConfig({
      TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    });
    const healthyDrain = {
      readiness: () => ({ state: "ready", ready: true }),
    } as never;
    const disabledDrain = {
      readiness: () => ({ state: "disabled", ready: false }),
    } as never;
    const service = new NormalDeploymentCommandService(
      config,
      fixture,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      healthyDrain,
    );

    let disabledPlannerCalls = 0;
    const disabled = new NormalDeploymentCommandService(
      fixedConfig({
        TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED: "false",
        TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
        TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      }),
      fixture,
      { prepare: async () => { disabledPlannerCalls += 1; return {} as never; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      disabledDrain,
      {} as never,
    );
    assert.deepEqual(await disabled.deploy(user, projectId), {
      deployment: {
        state: "platform_attention",
        message: "The platform cannot continue this deployment automatically. No deployment was started.",
      },
    });
    assert.equal(disabledPlannerCalls, 0, "disabled command must stop before planning");

    let preparedCalls = 0;
    let planDispatches = 0;
    const enabled = new NormalDeploymentCommandService(
      config,
      fixture,
      {
        prepare: async () => {
          preparedCalls += 1;
          return {
            state: "prepared",
            firstRelease: true,
            fallbackToLegacy: false,
            safeCodes: ["FIRST_RELEASE_INTENT_PREPARED"],
            intent: {
              id: intent.id,
              safeId: intent.id.slice(0, 8),
              status: intent.status,
              replayed: false,
              nextBoundary: "infrastructure_plan",
            },
          };
        },
      } as never,
      {} as never,
      { dispatch: async () => { planDispatches += 1; return { state: "dispatched" }; } } as never,
      {} as never,
      {} as never,
      {} as never,
      healthyDrain,
    );
    assert.deepEqual(await enabled.deploy(user, projectId), {
      deployment: {
        state: "accepted",
        message: "Deployment accepted. Infrastructure planning is queued.",
      },
    });
    assert.equal(preparedCalls, 1);
    assert.equal(planDispatches, 1);

    await assert.rejects(
      service.deploy({ id: user.id, role: UserRole.READONLY } as User, projectId),
      /permission/i,
    );
    await assert.rejects(
      service.deploy({ id: user.id + 10_000, role: UserRole.DEVELOPER } as User, projectId),
      /permission/i,
    );
    await assert.rejects(
      service.approveCost({ id: user.id + 10_000, role: UserRole.ADMIN } as User, projectId),
      /project owner/i,
    );

    await Promise.all(Array.from({ length: 12 }, () =>
      (service as any).bindCommand(intent.id, user.id),
    ));
    const persisted = await fixture.getRepository(DeploymentIntent).findOneByOrFail({ id: intent.id });
    const marker = persisted.decision?.developerCommand as Record<string, unknown>;
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.requestedByUserId, user.id);
    assert.match(String(marker.operationKey), /^[0-9a-f]{64}$/);
    const operationKey = marker.operationKey;

    await (service as any).bindCommand(intent.id, user.id);
    const replay = await fixture.getRepository(DeploymentIntent).findOneByOrFail({ id: intent.id });
    assert.equal((replay.decision?.developerCommand as any).operationKey, operationKey);
    await assert.rejects(
      (service as any).bindCommand(intent.id, user.id, "c".repeat(64)),
      /NORMAL_V1_DEPLOYMENT_COMMAND_IDENTITY_CONFLICT/,
    );
    // The remaining assertions model a separate first-release operation in the
    // same disposable scope; remove the earlier marker so it cannot be mistaken
    // for that root's release continuation.
    await fixture.getRepository(DeploymentIntent).update(intent.id, { decision: null });
    const planHash = "d".repeat(64);
    const manifest = await fixture.getRepository(InfrastructureManifest).save({
      schemaVersion: 1,
      projectId,
      environmentName: "dev",
      revision: "1",
      parentManifestId: null,
      createdByIntentId: null,
      createdByUserId: user.id,
      origin: "planner",
      status: "planned",
      specHash: "e".repeat(64),
      terraformTemplateVersion: "test-v1",
      stateBackend: "local_mock",
      stateKey: `test/${projectId}/dev.tfstate`,
      stateVersionId: null,
      desiredSpec: {},
      changeSet: {},
      requiresTerraform: true,
      planArtifactReference: { review: {} },
      planArtifactSha256: planHash,
      planInputFingerprint: "f".repeat(64),
      planConfigurationFingerprint: "1".repeat(64),
      terraformOutputs: null,
      terraformOutputsHash: null,
      resourceCount: 2,
      failureCode: null,
      failureMessage: null,
      plannedAt: new Date(),
      approvedAt: null,
      applyStartedAt: null,
      appliedAt: null,
      supersededAt: null,
      destroyedAt: null,
    } as any);
    const root = await fixture.getRepository(DeploymentIntent).save({
      ...intent,
      id: randomUUID(),
      classification: "infrastructure_change",
      status: "plan_completed",
      clientIdempotencyKey: `normal-command-root-${suffix}`,
      canonicalIdempotencyKey: "2".repeat(64),
      requestFingerprint: "3".repeat(64),
      infrastructureManifestId: manifest.id,
      decision: { developerCommand: marker },
    });
    const child = await fixture.getRepository(DeploymentIntent).save({
      ...intent,
      id: randomUUID(),
      kind: "apply",
      classification: "infrastructure_change",
      status: "planned",
      clientIdempotencyKey: `normal-command-child-${suffix}`,
      canonicalIdempotencyKey: "4".repeat(64),
      requestFingerprint: "5".repeat(64),
      requestPayload: { operation: "infrastructure_apply_continuation", parentPlanIntentId: root.id },
      infrastructureManifestId: manifest.id,
      decision: { approvalRequired: true, executionLane: "infrastructure" },
    });
    const policy = decideAutomaticInfrastructurePolicy({
      planHash,
      resourceSummary: { create: 2, update: 0, replace: 0, delete: 0 },
      costEstimate: { state: "real", currency: "USD", monthlyCost: 12 },
      thresholdMonthlyCost: 25,
      maxResourceChanges: 100,
    });
    await Promise.all(Array.from({ length: 8 }, () =>
      (service as any).persistPolicy(root, child, manifest, policy),
    ));
    const persistedChild = await fixture.getRepository(DeploymentIntent).findOneByOrFail({ id: child.id });
    assert.equal((persistedChild.decision?.automaticContinuation as any).state, "auto_approved");
    assert.equal((persistedChild.decision?.automaticContinuation as any).evidenceHash, policy.evidenceHash);
    assert.equal(persistedChild.decision?.approvalRequired, false);
    assert.equal(await fixture.getRepository(DeploymentIntent).count({ where: { projectId, kind: "apply" } }), 1);
    let effectiveApplyDispatches = 0;
    let effectiveReleaseDispatches = 0;
    let releaseIntent: DeploymentIntent | null = null;
    const coordinator = new NormalDeploymentCommandService(
      config,
      fixture,
      {
        prepare: async () => {
          if (!releaseIntent) {
            releaseIntent = await fixture!.getRepository(DeploymentIntent).save({
              ...intent,
              id: randomUUID(),
              classification: "release_only",
              status: "planned",
              clientIdempotencyKey: `normal-command-release-${suffix}`,
              canonicalIdempotencyKey: "6".repeat(64),
              requestFingerprint: "7".repeat(64),
              infrastructureManifestId: manifest.id,
              releaseManifestId: randomUUID(),
              decision: null,
            });
          }
          return { state: "prepared", firstRelease: true, fallbackToLegacy: false, safeCodes: ["FIRST_RELEASE_INTENT_PREPARED"], intent: { id: releaseIntent.id, safeId: releaseIntent.id.slice(0, 8), status: releaseIntent.status, replayed: false, nextBoundary: "release" } };
        },
      } as any,
      {} as any,
      {} as any,
      {
        dispatchApprovedContinuation: async () => {
          if (effectiveApplyDispatches === 0) effectiveApplyDispatches += 1;
          return { state: "dispatched" };
        },
      } as any,
      {
        dispatch: async () => {
          if (effectiveReleaseDispatches === 0) effectiveReleaseDispatches += 1;
          return { state: "dispatched" };
        },
      } as any,
      {
        review: async () => ({
          planHash,
          resourceSummary: { create: 2, update: 0, replace: 0, delete: 0, noOp: 0, resourceTypes: [] },
          costEstimate: { state: "real", currency: "USD", monthlyCost: 12, resourceCount: 2 },
        }),
      } as any,
      healthyDrain,
    );
    await coordinator.advanceProject(projectId);
    await coordinator.advanceProject(projectId);
    assert.equal(effectiveApplyDispatches, 1, "automatic apply dispatch must be one effective action");
    await fixture.getRepository(DeploymentIntent).update(child.id, { status: "completed", completedAt: new Date() });
    await fixture.getRepository(InfrastructureManifest).update(manifest.id, { status: "applied", appliedAt: new Date() });
    const resumableRoot = await (coordinator as any).commandRoot(projectId);
    assert.ok(resumableRoot, "command-marked root must survive process-style coordinator replacement");
    assert.equal((await (coordinator as any).applyChild(resumableRoot))?.status, "completed");
    assert.ok(await fixture.getRepository(InfrastructureManifest).findOneBy({ id: manifest.id, status: "applied" }));
    await coordinator.advanceProject(projectId);
    await coordinator.advanceProject(projectId);
    assert.equal(effectiveReleaseDispatches, 1, "automatic release dispatch must be one effective action");
    assert.ok(releaseIntent);
    assert.equal((releaseIntent!.decision?.developerCommand as any)?.operationKey, undefined);
    const persistedRelease = await fixture.getRepository(DeploymentIntent).findOneByOrFail({ id: releaseIntent!.id });
    assert.equal((persistedRelease.decision?.developerCommand as any).operationKey, marker.operationKey);
    assert.equal(await fixture.getRepository(DeploymentIntent).count({ where: { projectId } }), 4);
    console.log("Serializable normal-v1 deployment command identity verification passed.");
  } finally {
    if (fixture?.isInitialized) await fixture.destroy();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.destroy();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
