import { strict as assert } from "node:assert";
import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentContractValidationService } from "../src/infrastructure/deployment-contract-validation.service";
import { InfrastructureService } from "../src/infrastructure/infrastructure.service";
import { ProjectInfrastructureEnvironment } from "../src/infrastructure/project-infrastructure-environment.entity";
import { ProjectDeploymentContract } from "../src/projects/project-deployment-contract.entity";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const contractFingerprint = "contract-fingerprint";
const inputFingerprint = "terraform-input-fingerprint";
const draftFingerprint = "task-draft-fingerprint";
const configurationFingerprint = "configuration-fingerprint";

export type Scenario =
  | "valid"
  | "invalid_contract"
  | "expired"
  | "consumed"
  | "modified_plan"
  | "modified_after_init"
  | "replaced_after_init"
  | "missing_after_init"
  | "path_changed_after_init"
  | "contract_changed_after_init"
  | "input_changed_after_init"
  | "stale"
  | "completed";

export async function harness(scenario: Scenario = "valid") {
  const workdir = await mkdtemp(join(tmpdir(), "deployguard-apply-entry-"));
  const planBytes = Buffer.from("immutable-saved-plan");
  await writeFile(join(workdir, "tfplan"), planBytes, { mode: 0o600 });
  const validator = new DeploymentContractValidationService();
  const artifactSha256 = createHash("sha256").update(planBytes).digest("hex");
  const planFingerprint = validator.planFingerprint(artifactSha256, inputFingerprint, contractFingerprint, runId);
  const bindingRevisions = [{ id: "binding-1", configurationFingerprint: "binding-v1" }];
  const now = Date.now();
  const run: any = {
    id: runId,
    projectId,
    status: PipelineRunStatus.RUNNING,
    currentStage: "terraform_apply_approval_queued",
    createdAt: new Date(now - 1_000),
    completedAt: null,
    failedAt: null,
    metadata: {
      deploymentContractSchemaVersion: 1,
      contractFingerprint,
      terraformInputFingerprint: inputFingerprint,
      taskDefinitionDraftFingerprint: draftFingerprint,
      managedBindingRevisions: bindingRevisions,
      desiredStateRevision: configurationFingerprint,
      configurationFingerprint,
      applyApprovedRunId: runId,
      applyApprovedAt: new Date(now - 1_000).toISOString(),
      applyApprovedPlanFingerprint: planFingerprint,
      applyApprovedContractFingerprint: contractFingerprint,
      applyApprovedTerraformInputFingerprint: inputFingerprint,
    },
  };
  const latestRun: any = scenario === "stale"
    ? { ...run, id: "33333333-3333-4333-8333-333333333333", createdAt: new Date(now) }
    : run;
  const environment: any = {
    id: "44444444-4444-4444-8444-444444444444",
    projectId,
    pipelineRunId: runId,
    status: "cost_check_required",
    terraformWorkspacePath: workdir,
    terraformPlanSummary: { create: 1, update: 0, delete: 0 },
    metadata: {
      deploymentContractSchemaVersion: 1,
      contractFingerprint,
      terraformInputFingerprint: inputFingerprint,
      taskDefinitionDraftFingerprint: draftFingerprint,
      managedBindingRevisions: bindingRevisions,
      planConfigurationFingerprint: configurationFingerprint,
      planPolicyStatus: "passed",
      planPolicyMode: "known",
      planTaskDefinitionDraftFingerprint: draftFingerprint,
      planArtifactSha256: artifactSha256,
      planFingerprint,
      planGeneratedAt: new Date(now - 1_000).toISOString(),
      planExpiresAt: new Date(now + 120_000).toISOString(),
    },
  };
  const contract: any = {
    projectId,
    deployable: true,
    contractHash: "contract-revision",
  };
  const snapshot: any = {
    id: "snapshot-1",
    projectId,
    pipelineRunId: runId,
    configurationFingerprint,
    bindingRevisions,
  };
  if (scenario === "expired") run.metadata.applyApprovedAt = new Date(now - 7_200_000).toISOString();
  if (scenario === "consumed") run.metadata.applyApprovalConsumedAt = new Date(now - 500).toISOString();
  if (scenario === "completed") run.metadata.terraformApplyCompletedAt = new Date(now - 500).toISOString();
  if (scenario === "modified_plan") await writeFile(join(workdir, "tfplan"), "modified-after-approval", { mode: 0o600 });

  let applyCalls = 0;
  const appliedPlanPaths: string[] = [];
  let transactionTail = Promise.resolve();
  const runRepository: any = {
    findOne: async (query: any) => query?.where?.id === runId ? run : latestRun,
    save: async (value: any) => value,
  };
  const environmentRepository: any = {
    findOne: async () => environment,
    save: async (value: any) => value,
  };
  const eventRepository: any = { findOne: async () => null };
  const manager: any = {
    query: async () => undefined,
    getRepository(entity: unknown) {
      if (entity === ProjectPipelineRun) return runRepository;
      if (entity === ProjectInfrastructureEnvironment) return environmentRepository;
      if (entity === ProjectDeploymentContract) return { findOne: async () => contract };
      if (entity === ProjectPipelineEvent) return eventRepository;
      throw new Error("Unexpected repository");
    },
    transaction: async (work: (manager: any) => Promise<unknown>) => {
      let release!: () => void;
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await work(manager);
      } finally {
        release();
      }
    },
  };
  runRepository.manager = manager;

  const service = Object.create(InfrastructureService.prototype) as any;
  Object.assign(service, {
    config: {
      get(key: string, fallback: unknown) {
        const values: Record<string, unknown> = {
          TERRAFORM_APPLY_ENABLED: "true",
          TERRAFORM_APPLY_REQUIRES_APPROVAL: "true",
          TERRAFORM_APPLY_APPROVAL_TTL_SECONDS: "3600",
          STATE_MOCK_MODE: "true",
        };
        return values[key] ?? fallback;
      },
    },
    contractRepository: { findOne: async () => contract },
    runRepository,
    environmentRepository,
    databaseBindings: {
      assertRunConfigurationCurrent: async () => snapshot,
      markProvisioning: async () => undefined,
    },
    deploymentContractValidation: validator,
    awsCliService: { validateCredentials: async () => undefined },
    stateLockService: {
      buildLockId: () => "lock-1",
      acquireLock: async () => ({ acquired: true }),
    },
    stateHeartbeatService: { startHeartbeat: async () => undefined },
    terraformRunner: {
      runTerraformInit: async () => {
        if (scenario === "modified_after_init") {
          await writeFile(join(workdir, "tfplan"), "modified-after-init", { mode: 0o600 });
        }
        if (scenario === "replaced_after_init") {
          const replacement = join(workdir, "replacement.tfplan");
          await writeFile(replacement, planBytes, { mode: 0o600 });
          await rename(replacement, join(workdir, "tfplan"));
        }
        if (scenario === "missing_after_init") await unlink(join(workdir, "tfplan"));
        if (scenario === "path_changed_after_init") environment.terraformWorkspacePath = join(workdir, "different");
        if (scenario === "contract_changed_after_init") environment.metadata.contractFingerprint = "changed-contract";
        if (scenario === "input_changed_after_init") environment.metadata.terraformInputFingerprint = "changed-input";
      },
      runTerraformApply: async (_workdir: string, _env: NodeJS.ProcessEnv, planPath: string) => {
        applyCalls += 1;
        appliedPlanPaths.push(planPath);
      },
      parseOutputs: async () => ({}),
    },
  });
  service.requireProject = async () => ({ id: projectId, repositoryFullName: "example/app" });
  service.assertCostGatePassed = async () => undefined;
  service.createOrGetInfrastructureEnvironment = async () => environment;
  service.verifyStateBackend = async () => undefined;
  service.event = async () => undefined;
  service.audit = async () => undefined;
  service.terraformEnv = () => ({});
  service.saveInfrastructureOutputs = async () => ({ ...environment, status: "provisioned" });
  service.validateAndPersistState = async () => undefined;
  service.releaseStateLock = async () => undefined;
  service.buildValidatedTerraformInputs = async () => {
    if (scenario === "invalid_contract") {
      const canonical: any = {
        contractFingerprint,
        runtimeEntries: [{
          key: "DB_PASSWORD",
          owner: "managed_service",
          sensitivity: "secret",
          destination: "ecs_secret",
          bindingId: "binding-1",
          bindingRevision: "binding-v1",
        }],
      };
      validator.assertRenderedDraft(canonical, {
        contractFingerprint,
        terraformInputFingerprint: inputFingerprint,
        draftFingerprint,
        environmentNames: ["DB_PASSWORD"],
        secretNames: [],
        managedSecretTypes: {},
      });
      throw new BadRequestException({ code: "contract_invalid" });
    }
    return {
      canonical: {
        schemaVersion: 1,
        deploymentContractRevision: "contract-revision",
        contractFingerprint,
      },
      taskDefinitionDraft: {
        contractFingerprint,
        terraformInputFingerprint: inputFingerprint,
        draftFingerprint,
        environmentNames: [],
        secretNames: [],
        managedSecretTypes: {},
      },
      terraformInputFingerprint: inputFingerprint,
      bindingRevisions,
    };
  };

  return {
    service,
    workdir,
    run,
    environment,
    appliedPlanPaths,
    get applyCalls() { return applyCalls; },
  };
}

export async function rejected(scenario: Exclude<Scenario, "valid">, expectedCode: string) {
  const fixture = await harness(scenario);
  try {
    await assert.rejects(
      () => fixture.service.runInfrastructureApply(projectId, runId),
      (error: any) => {
        const response = error?.getResponse?.();
        return String(response?.code || "") === expectedCode;
      },
    );
    assert.equal(fixture.applyCalls, 0, `${scenario} must not invoke Terraform apply`);
  } finally {
    await rm(fixture.workdir, { recursive: true, force: true });
  }
}

export async function runApplyEntryPointVerification() {
  await rejected("invalid_contract", "contract_invalid");
  await rejected("expired", "approval_expired");
  await rejected("consumed", "approval_consumed");
  await rejected("modified_plan", "plan_stale");
  await rejected("stale", "run_superseded");
  await rejected("completed", "apply_already_completed");

  const valid = await harness();
  try {
    await valid.service.runInfrastructureApply(projectId, runId);
    assert.equal(valid.applyCalls, 1, "valid current approval invokes the executor exactly once");
  } finally {
    await rm(valid.workdir, { recursive: true, force: true });
  }

  const concurrent = await harness();
  try {
    const results = await Promise.allSettled([
      concurrent.service.runInfrastructureApply(projectId, runId),
      concurrent.service.runInfrastructureApply(projectId, runId),
    ]);
    assert.equal(concurrent.applyCalls, 1, "concurrent apply attempts invoke the executor at most once");
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  } finally {
    await rm(concurrent.workdir, { recursive: true, force: true });
  }
  console.log("Atomic Terraform apply entry-point verification passed");
}

if (require.main === module) void runApplyEntryPointVerification();
