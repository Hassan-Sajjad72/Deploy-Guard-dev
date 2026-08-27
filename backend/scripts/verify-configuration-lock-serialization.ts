import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireProjectConfigurationAdvisoryLock,
  DatabaseServiceBindingService,
  projectConfigurationAdvisoryLockKey,
} from "../src/infrastructure/database-service-binding.service";
import { ProjectPersistentStorage } from "../src/storage/project-persistent-storage.entity";
import { ProjectConfigurationSnapshot } from "../src/projects/project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "../src/projects/project-database-tier.entity";
import { ProjectDeploymentContract } from "../src/projects/project-deployment-contract.entity";
import { ProjectDetectionProfile } from "../src/projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../src/projects/project-environment-variable.entity";
import { ProjectServiceBinding } from "../src/projects/project-service-binding.entity";
import { analysisFingerprint } from "../src/projects/analysis-fingerprint";
import { Project } from "../src/projects/project.entity";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire() {
    if (this.locked) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

function transactionalManager(mutex: Mutex) {
  return {
    async transaction<T>(work: (manager: any) => Promise<T>) {
      const releases: Array<() => void> = [];
      const manager = {
        query: async (_sql: string, values: string[]) => {
          assert.equal(values[0], projectConfigurationAdvisoryLockKey(projectId, "production"));
          releases.push(await mutex.acquire());
        },
      };
      try {
        return await work(manager);
      } finally {
        releases.reverse().forEach((release) => release());
      }
    },
  };
}

async function verifyTransactionManagerReads() {
  const contractHash = "contract-hash";
  const currentFingerprint = analysisFingerprint({
    projectId,
    environment: "dev",
    contractHash,
    binding: null,
    plainValues: {},
    buildValues: {},
    secretSources: {},
    sourceRevisions: {},
  });
  const snapshot = {
    id: "snapshot-1",
    projectId,
    pipelineRunId: runId,
    environment: "dev",
    configurationFingerprint: currentFingerprint,
    bindingRevisions: [],
  };
  const contract = {
    projectId,
    contractHash,
    databaseRequired: false,
    persistentStorageRequired: false,
    requiredEnvVars: [],
    optionalEnvVars: [],
    runtimeEnvVars: [],
    buildTimeEnvVars: [],
    runtimeType: "static",
    ecsPlan: { containerPort: 3000 },
  };
  const used = new Set<unknown>();
  const emptyRepository = { findOne: async () => null };
  const variables = {
    createQueryBuilder: () => ({
      addSelect() { return this; },
      where() { return this; },
      andWhere() { return this; },
      orderBy() { return this; },
      getMany: async () => [],
    }),
  };
  const manager: any = {
    getRepository(entity: unknown) {
      used.add(entity);
      if (entity === ProjectConfigurationSnapshot) return { findOne: async () => snapshot };
      if (entity === Project) return { findOne: async () => ({ id: projectId, environmentName: "dev" }) };
      if (entity === ProjectDeploymentContract) return { findOne: async () => contract };
      if (entity === ProjectDetectionProfile) return { findOne: async () => ({ projectId, rawProfile: {}, inputFingerprint: "scan" }) };
      if (entity === ProjectEnvironmentVariable) return variables;
      if ([ProjectServiceBinding, ProjectDatabaseTier, ProjectPersistentStorage].includes(entity as never)) return emptyRepository;
      throw new Error("Unexpected transaction repository");
    },
  };
  const outside = new Proxy({}, {
    get() { throw new Error("Eligibility read escaped the supplied EntityManager"); },
  });
  const service = new DatabaseServiceBindingService(
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    outside as never,
    { decrypt: () => "" } as never,
    { get: (_key: string, fallback: string) => fallback } as never,
  );
  const preview = await (service as unknown as { buildEffectiveConfiguration(projectId: string, runId: string, environment: string, options: Record<string, unknown>): Promise<{ configurationFingerprint: string }> })
    .buildEffectiveConfiguration(projectId, runId, "dev", { manager, requireReady: false, useSnapshot: false });
  snapshot.configurationFingerprint = preview.configurationFingerprint;
  used.clear();
  const result = await service.assertRunConfigurationCurrent(projectId, runId, manager);
  assert.equal(result.id, snapshot.id);
  for (const entity of [
    ProjectConfigurationSnapshot,
    ProjectDeploymentContract,
    ProjectDetectionProfile,
    ProjectServiceBinding,
    ProjectDatabaseTier,
    ProjectEnvironmentVariable,
    ProjectPersistentStorage,
  ]) assert.ok(used.has(entity), `${String((entity as any).name)} must use the supplied EntityManager`);
}

async function verifyLockOrdering() {
  const mutex = new Mutex();
  const transactions = transactionalManager(mutex);
  const mutationHasLock = deferred();
  const allowMutationCommit = deferred();
  let configurationFingerprint = "old";
  let applyCalls = 0;
  const mutation = transactions.transaction(async (manager) => {
    await acquireProjectConfigurationAdvisoryLock(manager as never, projectId, "production");
    mutationHasLock.resolve();
    await allowMutationCommit.promise;
    configurationFingerprint = "new";
  });
  await mutationHasLock.promise;
  const apply = transactions.transaction(async (manager) => {
    await acquireProjectConfigurationAdvisoryLock(manager as never, projectId, "production");
    if (configurationFingerprint !== "old") return false;
    applyCalls += 1;
    return true;
  });
  await Promise.resolve();
  assert.equal(applyCalls, 0, "apply eligibility must wait for the earlier configuration mutation");
  allowMutationCommit.resolve();
  await mutation;
  assert.equal(await apply, false);
  assert.equal(applyCalls, 0);

  const secondMutex = new Mutex();
  const secondTransactions = transactionalManager(secondMutex);
  const applyHasLock = deferred();
  const allowApplyCommit = deferred();
  let durableApplyStarted = false;
  let mutationObservedDurableStart = false;
  const firstApply = secondTransactions.transaction(async (manager) => {
    await acquireProjectConfigurationAdvisoryLock(manager as never, projectId, "production");
    applyHasLock.resolve();
    durableApplyStarted = true;
    await allowApplyCommit.promise;
  });
  await applyHasLock.promise;
  const laterMutation = secondTransactions.transaction(async (manager) => {
    await acquireProjectConfigurationAdvisoryLock(manager as never, projectId, "production");
    mutationObservedDurableStart = durableApplyStarted;
  });
  await Promise.resolve();
  assert.equal(mutationObservedDurableStart, false);
  allowApplyCommit.resolve();
  await firstApply;
  await laterMutation;
  assert.equal(mutationObservedDurableStart, true);
}

async function verifyProtectedMutationPaths() {
  const files = [
    "src/projects/projects.service.ts",
    "src/projects/deployment-contract.service.ts",
    "src/projects/deployment-requirements.service.ts",
    "src/projects/database-tier.service.ts",
    "src/projects/detection/deployment-profile.service.ts",
    "src/storage/storage.service.ts",
  ];
  for (const file of files) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    assert.match(source, /acquireProjectConfigurationAdvisoryLock/);
  }
  const projects = await readFile(join(process.cwd(), "src/projects/projects.service.ts"), "utf8");
  assert.match(projects, /const deploymentAffecting = dto\.appDirectory !== undefined \|\| dto\.deploymentOverrides !== undefined/);
  assert.match(projects, /const savedProject = deploymentAffecting\s*\?\s*await this\.dataSource\.transaction/);
  assert.notEqual(
    analysisFingerprint({ appDirectory: ".", deploymentOverrides: {} }),
    analysisFingerprint({ appDirectory: "server", deploymentOverrides: { port: 8080 } }),
  );
}

async function verifyAtMostOnce() {
  const mutex = new Mutex();
  const transactions = transactionalManager(mutex);
  let durableApplyStarted = false;
  let executorCalls = 0;
  const attempt = async () => {
    const claimed = await transactions.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager as never, projectId, "production");
      if (durableApplyStarted) return false;
      durableApplyStarted = true;
      return true;
    });
    if (claimed) executorCalls += 1;
  };
  await Promise.all([attempt(), attempt()]);
  assert.equal(executorCalls, 1);
}

async function main() {
  assert.equal(
    projectConfigurationAdvisoryLockKey(projectId, "production"),
    `project_configuration:${projectId}:production`,
  );
  await verifyTransactionManagerReads();
  await verifyLockOrdering();
  await verifyProtectedMutationPaths();
  await verifyAtMostOnce();
  console.log("Project configuration advisory-lock serialization and transaction-manager verification passed.");
}

void main();
