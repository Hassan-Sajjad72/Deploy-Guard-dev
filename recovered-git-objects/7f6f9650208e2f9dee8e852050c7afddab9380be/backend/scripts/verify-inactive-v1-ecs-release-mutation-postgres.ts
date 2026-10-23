import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";
import { CreateDeploymentSideEffectJournal1760000039000 } from "../src/migrations/1760000039000-CreateDeploymentSideEffectJournal";
import { CreateReleaseImageProvenances1760000047000 } from "../src/migrations/1760000047000-CreateReleaseImageProvenances";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { InactiveV1EcsReleaseMutationAdapter } from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.adapter";
import { InactiveV1EcsReleaseManifestStore } from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-manifest.store";
import {
  V1EcsReleaseManifestPair,
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationClient,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import { InactiveV1HandlerSideEffectSafetyService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-handler-side-effect-safety.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session7_1_ecs_release_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema.");
const baseOptions = AppDataSource.options as DataSourceOptions & {
  extra?: Record<string, unknown>;
};
const admin = new DataSource({
  ...baseOptions,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities: [InfrastructureManifest, ReleaseManifest],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(baseOptions.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestPair(
  projectId: string,
  infrastructureManifestId: string,
  releaseManifestId: string,
): V1EcsReleaseManifestPair {
  const desiredSpec = {
    region: "us-east-1",
    terraformTemplateVersion: "v1",
    network: {
      topology: "managed_vpc" as const,
      availabilityZoneCount: 2,
      publicSubnets: true,
      privateSubnets: true,
      natMode: "single" as const,
    },
    registry: {
      managedEcrRepository: true,
      immutableTags: true,
      lifecyclePolicyHash: null,
    },
    ecsFoundation: {
      clusterMode: "shared_project" as const,
      serviceName: "deployguard-app",
      launchType: "fargate" as const,
      capacityProviders: ["FARGATE"],
    },
    ingress: {
      enabled: true,
      protocol: "HTTP" as const,
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/api/health",
      healthCheckProtocol: "HTTP" as const,
    },
    database: {
      mode: "none" as const,
      engine: null,
      tierRevision: null,
      persistence: false,
      externalTlsRequired: null,
    },
    storage: {
      efsRequired: false,
      accessPointRequired: false,
      encrypted: true,
      backupRequired: false,
    },
    discovery: { cloudMapRequired: false, namespace: null },
    observability: {
      cloudWatchLogs: true,
      cloudWatchMetrics: true,
      prometheus: false,
    },
    iamPolicyRevision: "v1",
    tags: { managedBy: "DeployGuard" },
  };
  const releaseSpec = {
    source: {
      repositoryFullName: "example/web-app",
      branch: "main",
      commitSha: "b".repeat(40),
      appRoot: ".",
    },
    build: {
      dockerStrategy: "generated" as const,
      dockerTemplate: "node-server-v1",
      buildCommand: "npm run build",
      outputDirectory: null,
      buildArgumentNames: [],
    },
    runtime: {
      imageUri: null,
      imageDigest: null,
      command: "npm start",
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      plainVariableNames: ["NODE_ENV"],
      secretReferenceNames: ["DATABASE_URL"],
      serviceBindingRevisions: [],
    },
    health: {
      path: "/api/health",
      expectedPort: 3000,
      gracePeriodSeconds: 60,
    },
  };
  const outputs = {
    ecs_cluster_arn:
      "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project",
    ecs_service_arn:
      "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app",
    ecs_service_name: "deployguard-app",
    ecs_task_definition_arn:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:7",
    ecs_container_name: "app",
    ecs_log_group_name: "/deployguard/project/app",
  };
  return {
    infrastructure: {
      id: infrastructureManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "4",
      parentManifestId: null,
      createdByIntentId: null,
      createdByUserId: null,
      origin: "planner",
      status: "applied",
      specHash: canonicalSha256(desiredSpec),
      terraformTemplateVersion: "v1",
      stateBackend: "s3",
      stateKey: `projects/${projectId}/terraform.tfstate`,
      desiredSpec,
      changeSet: {
        fromManifestId: null,
        changedPaths: [],
        categories: [],
        destructivePaths: [],
        requiresApproval: false,
        reasonCodes: [],
      },
      requiresTerraform: true,
      terraformOutputs: outputs,
      terraformOutputsHash: canonicalSha256(outputs),
    },
    release: {
      id: releaseManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "8",
      parentManifestId: null,
      previousStableManifestId: null,
      infrastructureManifestId,
      createdByIntentId: null,
      pipelineRunId: null,
      deploymentContractId: null,
      configurationSnapshotId: randomUUID(),
      origin: "planner",
      status: "built",
      specHash: canonicalSha256(releaseSpec),
      repositoryFullName: releaseSpec.source.repositoryFullName,
      branch: releaseSpec.source.branch,
      commitSha: releaseSpec.source.commitSha,
      appRoot: releaseSpec.source.appRoot,
      deploymentContractHash: hash("deployment-contract"),
      configurationFingerprint: hash("configuration"),
      buildFingerprint: hash("build"),
      runtimeFingerprint: hash("runtime"),
      releaseSpec,
      imageUri:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app:build-8",
      imageDigest: `sha256:${"e".repeat(64)}`,
      taskDefinitionInputHash: null,
      taskDefinitionArn: null,
    },
  };
}

class FixtureManifestStore implements V1EcsReleaseManifestStore {
  constructor(public pair: V1EcsReleaseManifestPair) {}

  async loadExact() {
    return this.pair;
  }

  async recordTaskDefinitionReference(input: {
    taskDefinitionInputHash: string;
    taskDefinitionArn: string;
    fence: {
      intentId: string;
      leaseId: string;
      workerId: string;
      fencingToken: string;
    };
  }) {
    assert.match(input.fence.intentId, /^[0-9a-f-]{36}$/);
    assert.match(input.fence.leaseId, /^[0-9a-f-]{36}$/);
    assert.equal(input.fence.fencingToken, "1");
    if (
      this.pair.release.taskDefinitionInputHash
      && this.pair.release.taskDefinitionInputHash
        !== input.taskDefinitionInputHash
    ) {
      throw new Error("ECS_RELEASE_TASK_REFERENCE_CONFLICT");
    }
    this.pair.release.taskDefinitionInputHash =
      input.taskDefinitionInputHash;
    this.pair.release.taskDefinitionArn = input.taskDefinitionArn;
    return {
      taskDefinitionInputHash: input.taskDefinitionInputHash,
      taskDefinitionArn: input.taskDefinitionArn,
    };
  }
}

class FixtureEcsClient implements V1EcsReleaseMutationClient {
  readonly policy = "deployguard.ecs-release-mutation/client-v1" as const;
  registerCalls = 0;
  updateCalls = 0;
  lastRegister: Record<string, unknown> | null = null;
  lastUpdate: Record<string, unknown> | null = null;
  afterRegister: (() => void) | null = null;

  async registerTaskDefinitionRevision(request: any, ownership: any) {
    this.registerCalls += 1;
    this.lastRegister = request;
    assert.equal(ownership.isLeaseTrusted(), true);
    this.afterRegister?.();
    return {
      taskDefinitionArn:
        "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:8",
    };
  }

  async updateExistingService(request: any, ownership: any) {
    this.updateCalls += 1;
    this.lastUpdate = request;
    assert.equal(ownership.isLeaseTrusted(), true);
    return { serviceArn: request.serviceArn };
  }
}

async function createSchema() {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  await dataSource.query(`CREATE TABLE projects (id uuid PRIMARY KEY)`);
  await dataSource.query(`
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      status varchar(32) NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      intent_id uuid NOT NULL REFERENCES deployment_intents(id),
      owner_worker_id varchar NOT NULL,
      fencing_token bigint NOT NULL,
      status varchar(24) NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await new CreateTwoLaneManifestsAndStateRevisions1760000034000().up(
      runner,
    );
    await new CreateDeploymentSideEffectJournal1760000039000().up(runner);
    await new CreateReleaseImageProvenances1760000047000().up(runner);
  } finally {
    await runner.release();
  }
}

async function fence(label: string) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const leaseId = randomUUID();
  const workerId = `session7.1-${label}`;
  await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, status
     ) VALUES ($1, $2, 'production', 'running')`,
    [intentId, projectId],
  );
  await dataSource.query(
    `INSERT INTO project_operation_leases (
       id, project_id, environment_name, intent_id, owner_worker_id,
       fencing_token, status, expires_at
     ) VALUES (
       $1, $2, 'production', $3, $4, 1, 'heartbeat_active',
       clock_timestamp() + interval '1 hour'
     )`,
    [leaseId, projectId, intentId, workerId],
  );
  let trusted = true;
  const cancellation = new AbortController();
  return {
    projectId,
    intentId,
    leaseId,
    workerId,
    execution: {
      signal: cancellation.signal,
      isLeaseTrusted: () => trusted,
    },
    sideEffects: new InactiveV1HandlerSideEffectSafetyService(
      dataSource,
    ).forExecution({
      intentId,
      projectId,
      environmentName: "production",
      leaseId,
      workerId,
      fencingToken: "1",
      signal: cancellation.signal,
      isLeaseTrusted: () => trusted,
    }),
    loseTrust: () => {
      trusted = false;
    },
    cancel: () => cancellation.abort(),
  };
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();
    const owned = await fence("success");
    const infrastructureManifestId = randomUUID();
    const releaseManifestId = randomUUID();
    const store = new FixtureManifestStore(
      manifestPair(
        owned.projectId,
        infrastructureManifestId,
        releaseManifestId,
      ),
    );
    const client = new FixtureEcsClient();
    const adapter = new InactiveV1EcsReleaseMutationAdapter(store, client);
    const input = {
      revision: {
        projectId: owned.projectId,
        environmentName: "production",
        releaseManifestId,
        releaseRevision: "8",
        infrastructureManifestId,
        infrastructureRevision: "4",
      },
      mutation: {
        idempotencyKey: hash("release-mutation"),
        registerTaskDefinitionOperationId: randomUUID(),
        updateServiceOperationId: randomUUID(),
      },
      timeoutMs: 5_000,
      execution: owned.execution,
      sideEffects: owned.sideEffects,
    };
    const result = await adapter.mutate(input);
    assert.equal(result.disposition, "service_update_recorded");
    assert.equal(client.registerCalls, 1);
    assert.equal(client.updateCalls, 1);
    assert.match(result.taskDefinitionArn, /task-definition\/deployguard-app:8$/);
    assert.equal(client.lastUpdate?.clusterArn, store.pair.infrastructure.terraformOutputs.ecs_cluster_arn);
    assert.equal(client.lastUpdate?.serviceArn, store.pair.infrastructure.terraformOutputs.ecs_service_arn);
    assert.equal(
      client.lastUpdate?.forceNewDeployment,
      true,
    );
    const serialized = JSON.stringify(client.lastRegister);
    assert.doesNotMatch(serialized, /secret-value|password-value|token-value/);
    assert.match(serialized, /secret_reference/);
    assert.match(serialized, /configuration_snapshot/);
    assert.match(serialized, /@sha256:[0-9a-f]{64}/);

    const exactOwner = await fence("exact-store");
    const storedInfrastructureId = randomUUID();
    const storedReleaseId = randomUUID();
    const storedPair = manifestPair(
      exactOwner.projectId,
      storedInfrastructureId,
      storedReleaseId,
    );
    storedPair.release.configurationSnapshotId = null;
    await dataSource.getRepository(InfrastructureManifest).save({
      ...storedPair.infrastructure,
      stateVersionId: null,
      planArtifactReference: null,
      planArtifactSha256: null,
      planInputFingerprint: null,
      planConfigurationFingerprint: null,
      resourceCount: null,
      failureCode: null,
      failureMessage: null,
      plannedAt: null,
      approvedAt: null,
      applyStartedAt: null,
      appliedAt: new Date(),
      supersededAt: null,
      destroyedAt: null,
    });
    await dataSource.getRepository(ReleaseManifest).save({
      ...storedPair.release,
      imageUri: storedPair.release.imageUri,
      imageDigest: storedPair.release.imageDigest,
      taskDefinitionInputHash: null,
      taskDefinitionArn: null,
      healthEvidence: null,
      failureCode: null,
      failureMessage: null,
      buildStartedAt: null,
      builtAt: new Date(),
      deploymentStartedAt: null,
      healthVerifiedAt: null,
      promotedAt: null,
      supersededAt: null,
      rollbackStartedAt: null,
      rolledBackAt: null,
    });
    const exactStore = new InactiveV1EcsReleaseManifestStore(dataSource);
    const exactIdentity = {
      projectId: exactOwner.projectId,
      environmentName: "production",
      releaseManifestId: storedReleaseId,
      releaseRevision: "8",
      infrastructureManifestId: storedInfrastructureId,
      infrastructureRevision: "4",
    };
    const exactLoaded = await exactStore.loadExact(exactIdentity);
    assert.equal(exactLoaded?.release.id, storedReleaseId);
    assert.equal(exactLoaded?.infrastructure.id, storedInfrastructureId);
    assert.equal(
      await exactStore.loadExact({
        ...exactIdentity,
        infrastructureRevision: "5",
      }),
      null,
    );
    const storeInputHash = hash("stored-task-input");
    const storeTaskDefinitionArn =
      "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:9";
    const storedReference = await exactStore.recordTaskDefinitionReference({
      identity: exactIdentity,
      taskDefinitionInputHash: storeInputHash,
      taskDefinitionArn: storeTaskDefinitionArn,
      fence: {
        intentId: exactOwner.intentId,
        leaseId: exactOwner.leaseId,
        workerId: exactOwner.workerId,
        fencingToken: "1",
      },
    });
    assert.equal(storedReference.taskDefinitionArn, storeTaskDefinitionArn);
    await dataSource.query(
      `UPDATE project_operation_leases
       SET status = 'released'
       WHERE id = $1`,
      [exactOwner.leaseId],
    );
    await assert.rejects(
      exactStore.recordTaskDefinitionReference({
        identity: exactIdentity,
        taskDefinitionInputHash: storeInputHash,
        taskDefinitionArn: storeTaskDefinitionArn,
        fence: {
          intentId: exactOwner.intentId,
          leaseId: exactOwner.leaseId,
          workerId: exactOwner.workerId,
          fencingToken: "1",
        },
      }),
      /ECS_RELEASE_TASK_REFERENCE_CONFLICT/,
    );

    const replay = await adapter.mutate(input);
    assert.equal(replay.disposition, "service_update_recorded");
    assert.equal(replay.registerTaskDefinitionEffect.disposition, "replayed");
    assert.equal(replay.updateServiceEffect.disposition, "replayed");
    assert.equal(client.registerCalls, 1);
    assert.equal(client.updateCalls, 1);

    store.pair.release.taskDefinitionInputHash = null;
    store.pair.release.taskDefinitionArn = null;
    store.pair.release.imageDigest = `sha256:${"f".repeat(64)}`;
    await assert.rejects(
      adapter.mutate(input),
      /SIDE_EFFECT_IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(client.registerCalls, 1);
    assert.equal(client.updateCalls, 1);

    const lost = await fence("lost");
    const lostInfrastructureManifestId = randomUUID();
    const lostReleaseManifestId = randomUUID();
    const lostStore = new FixtureManifestStore(
      manifestPair(
        lost.projectId,
        lostInfrastructureManifestId,
        lostReleaseManifestId,
      ),
    );
    const lostClient = new FixtureEcsClient();
    lostClient.afterRegister = lost.loseTrust;
    const lostAdapter = new InactiveV1EcsReleaseMutationAdapter(
      lostStore,
      lostClient,
    );
    await assert.rejects(
      lostAdapter.mutate({
        revision: {
          projectId: lost.projectId,
          environmentName: "production",
          releaseManifestId: lostReleaseManifestId,
          releaseRevision: "8",
          infrastructureManifestId: lostInfrastructureManifestId,
          infrastructureRevision: "4",
        },
        mutation: {
          idempotencyKey: hash("lost-release-mutation"),
          registerTaskDefinitionOperationId: randomUUID(),
          updateServiceOperationId: randomUUID(),
        },
        timeoutMs: 5_000,
        execution: lost.execution,
        sideEffects: lost.sideEffects,
      }),
      /ECS_RELEASE_MUTATION_BLOCKED/,
    );
    assert.equal(lostClient.registerCalls, 1);
    assert.equal(lostClient.updateCalls, 0);

    const cancelled = await fence("cancelled");
    cancelled.cancel();
    const cancelledClient = new FixtureEcsClient();
    const cancelledInfrastructureManifestId = randomUUID();
    const cancelledReleaseManifestId = randomUUID();
    await assert.rejects(
      new InactiveV1EcsReleaseMutationAdapter(
        new FixtureManifestStore(manifestPair(
          cancelled.projectId,
          cancelledInfrastructureManifestId,
          cancelledReleaseManifestId,
        )),
        cancelledClient,
      ).mutate({
        revision: {
          projectId: cancelled.projectId,
          environmentName: "production",
          releaseManifestId: cancelledReleaseManifestId,
          releaseRevision: "8",
          infrastructureManifestId: cancelledInfrastructureManifestId,
          infrastructureRevision: "4",
        },
        mutation: {
          idempotencyKey: hash("cancelled-release-mutation"),
          registerTaskDefinitionOperationId: randomUUID(),
          updateServiceOperationId: randomUUID(),
        },
        timeoutMs: 5_000,
        execution: cancelled.execution,
        sideEffects: cancelled.sideEffects,
      }),
      /ECS_RELEASE_OWNERSHIP_LOST/,
    );
    assert.equal(cancelledClient.registerCalls, 0);
    assert.equal(cancelledClient.updateCalls, 0);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM deployment_side_effects
       WHERE intent_id = $1`,
      [owned.intentId],
    );
    assert.equal(count, 2);
    console.log(
      "Inactive v1 ECS release mutation isolated PostgreSQL verification passed",
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
