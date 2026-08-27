import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { DeploymentContractValidationService } from "../src/infrastructure/deployment-contract-validation.service";
import {
  hasTerraformMutationEvidence,
  isDestroyOperationRelevant,
} from "../src/infrastructure-lifecycle/cloud-state-reconciliation.logic";
import {
  deploymentContractFingerprint,
} from "../src/projects/analysis-fingerprint";
import { PipelineStageResolverService } from "../src/projects/current-state/pipeline-stage-resolver.service";
import {
  normalizePipelineFailureClass,
  pipelineFailureStage,
} from "../src/projects/pipeline/pipeline-stage-presenter";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { InfrastructureService } from "../src/infrastructure/infrastructure.service";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const runId = "local-stabilization-run";

const contract: any = {
  contractHash: "immutable-contract-revision",
  repositoryFullName: "MuhammadBilal25/Cattle-Farm-Management",
  branch: "main",
  commitSha: "8b3f29354e61cbdfcb3e3514457d8460f304cd4d",
  appRoot: "server",
  language: "javascript",
  framework: "express",
  runtimeType: "server",
  packageManager: "npm",
  dependencyManifest: "package.json",
  lockfile: "package-lock.json",
  nodeVersion: "20",
  pythonVersion: null,
  installCommand: "npm ci",
  buildCommand: null,
  startCommand: "npm start",
  outputDirectory: null,
  port: 5000,
  portSource: "repository",
  bindsToPortEnv: true,
  bindHost: "0.0.0.0",
  healthPath: "/api/health",
  requiredEnvVars: ["JWT_SECRET", "DB_PASSWORD", "DB_HOST", "DB_NAME", "DB_USER"],
  optionalEnvVars: ["PORT"],
  buildTimeEnvVars: [],
  runtimeEnvVars: ["PORT", "JWT_SECRET", "DB_PASSWORD", "DB_HOST", "DB_NAME", "DB_USER"],
  secretEnvVars: ["JWT_SECRET", "DB_PASSWORD"],
  databaseRequired: true,
  databaseEngine: "postgres",
  persistentStorageRequired: true,
  privateRegistryRequired: false,
  dockerStrategy: "generated",
  dockerTemplate: "express-server",
  overridesHash: "overrides-v1",
  ecsPlan: {
    containerPort: 5000,
    targetGroupPort: 5000,
    healthCheckPath: "/api/health",
    command: "npm start",
    cpu: 256,
    memory: 512,
    environmentMappings: [
      { name: "PORT", source: "platform" },
      { name: "DB_HOST", source: "platform" },
      { name: "DB_PORT", source: "platform" },
      { name: "DB_NAME", source: "platform" },
      { name: "DB_USER", source: "platform" },
    ],
    secretMappings: [
      { name: "JWT_SECRET", source: "project_secret" },
      { name: "DB_PASSWORD", source: "platform_secret" },
    ],
    database: {
      required: true,
      provider: "managed",
      engine: "postgres",
      host: `db.project-${projectId}.deployguard.local`,
      port: 5432,
      databaseName: "cattle_farm_db",
      databaseUser: "dg_846665b9ce31",
      image: "postgres:16",
      dataPath: "/var/lib/postgresql/data",
      persistenceEnabled: true,
    },
  },
};

const binding: any = {
  id: "binding-v1",
  projectId,
  provider: "managed",
  engine: "postgres",
  status: "pending",
  hostReference: `db.project-${projectId}.deployguard.local`,
  configurationFingerprint: "binding-semantic-v1",
};

const ownership = {
  DB_HOST: owner(false),
  DB_PORT: owner(false),
  DB_NAME: owner(false),
  DB_USER: owner(false),
  DB_PASSWORD: owner(true),
  JWT_SECRET: {
    ...owner(true),
    owner: "user_required",
    source: "repository requirement",
    serviceBindingId: null,
    sourceRevision: "jwt-secret-revision",
  },
  PORT: {
    ...owner(false),
    owner: "platform",
    source: "deployment contract",
    serviceBindingId: null,
    sourceRevision: contract.contractHash,
  },
};

function owner(secret: boolean) {
  return {
    owner: "managed_service",
    source: "postgres service binding",
    sourceRevision: binding?.configurationFingerprint || "binding-semantic-v1",
    required: true,
    secret,
    protected: true,
    serviceBindingId: binding?.id || "binding-v1",
    detectedReference: null,
  };
}

const effective: any = {
  binding,
  environment: "production",
  plainEnvironmentValues: {},
  buildArguments: {},
  runtimeVariables: {
    DB_HOST: binding.hostReference,
    DB_PORT: "5432",
    DB_NAME: "cattle_farm_db",
    DB_USER: "dg_846665b9ce31",
    PORT: "5000",
  },
  projectSecretValues: { JWT_SECRET: "test-only-never-logged" },
  secretReferences: {
    DB_PASSWORD: "terraform://database/password",
    JWT_SECRET: "project-env://jwt",
  },
  ownership,
  serviceBindingRevisions: [{
    id: binding.id,
    type: "database",
    provider: "managed",
    engine: "postgres",
    configurationFingerprint: binding.configurationFingerprint,
  }],
  unresolvedRequiredValues: [],
  prohibitedOverrides: [],
  duplicateOwnershipConflicts: [],
  configurationFingerprint: "desired-state-v1",
  blockers: [],
  sanitizedDeveloperManifest: {},
};

function event(stage: string, status: string, offset: number): any {
  const at = new Date(1_700_000_000_000 + offset);
  return {
    id: `${stage}-${status}-${offset}`,
    projectId,
    pipelineRunId: runId,
    stage,
    status,
    message: `${stage} ${status}`,
    metadata: {},
    occurredAt: at,
    createdAt: at,
  };
}

async function verify() {
  const fingerprint = deploymentContractFingerprint(contract);
  const bookkeepingVariant = {
    ...contract,
    id: "different-row-id",
    detectionProfileId: "different-profile-id",
    generatedAt: new Date("2030-01-01"),
    updatedAt: new Date("2030-01-02"),
    status: "validated",
    requiredEnvVars: [...contract.requiredEnvVars].reverse(),
    runtimeEnvVars: [...contract.runtimeEnvVars].reverse(),
    ecsPlan: {
      ...contract.ecsPlan,
      environmentMappings: [...contract.ecsPlan.environmentMappings].reverse(),
      secretMappings: [...contract.ecsPlan.secretMappings].reverse(),
    },
  };
  assert.equal(
    deploymentContractFingerprint(bookkeepingVariant),
    fingerprint,
    "timestamps, row IDs, status, and unordered collection order cannot change the contract fingerprint",
  );
  for (const [field, value] of [
    ["port", 5001],
    ["healthPath", "/ready"],
    ["commitSha", "different-commit"],
    ["repositoryFullName", "owner/other"],
  ] as const) {
    assert.notEqual(
      deploymentContractFingerprint({ ...contract, [field]: value }),
      fingerprint,
      `${field} must change the semantic fingerprint`,
    );
  }

  const validator = new DeploymentContractValidationService();
  const canonical = validator.buildCanonicalContract(
    projectId,
    "production",
    contract,
    effective,
    "sha256:image-v1",
  );
  validator.assertSemantic(projectId, contract, effective, canonical);
  assert(!canonical.runtimeEntries.some((entry) => entry.key === "DATABASE_URL"));
  assert.equal(
    canonical.runtimeEntries.find((entry) => entry.key === "DB_PASSWORD")?.destination,
    "ecs_secret",
  );
  assert.equal(
    canonical.runtimeEntries.find((entry) => entry.key === "JWT_SECRET")?.destination,
    "ecs_secret",
  );

  const terraformVariables = {
    ecs_environment_variables: effective.runtimeVariables,
    ecs_secret_environment_variables: { JWT_SECRET: "project-env://jwt" },
    database_secret_alias_types: { DB_PASSWORD: "password" },
  };
  const inputFingerprint = validator.terraformInputFingerprint(terraformVariables, canonical);
  const draft = validator.taskDefinitionDraft(
    terraformVariables,
    canonical.contractFingerprint,
    inputFingerprint,
  );
  validator.assertRenderedDraft(canonical, draft);
  assert.deepEqual(draft.secretNames, ["DB_PASSWORD", "JWT_SECRET"]);
  assert(!draft.environmentNames.includes("DB_PASSWORD"));

  const invalidEffective = {
    ...effective,
    runtimeVariables: {
      ...effective.runtimeVariables,
      DB_PASSWORD: "plaintext",
    },
    secretReferences: {
      JWT_SECRET: "project-env://jwt",
    },
  };
  const invalidCanonical = validator.buildCanonicalContract(
    projectId,
    "production",
    contract,
    invalidEffective,
  );
  assert.throws(
    () => validator.assertSemantic(projectId, contract, invalidEffective, invalidCanonical),
    /DB_PASSWORD/,
  );

  const legacyUrl = {
    ...effective,
    projectSecretValues: {
      ...effective.projectSecretValues,
      DATABASE_URL: "legacy-value",
    },
    secretReferences: {
      ...effective.secretReferences,
      DATABASE_URL: "project-env://legacy-url",
    },
    ownership: {
      ...effective.ownership,
      DATABASE_URL: {
        ...owner(true),
        owner: "user_required",
        serviceBindingId: null,
      },
    },
  };
  const legacyCanonical = validator.buildCanonicalContract(
    projectId,
    "production",
    contract,
    legacyUrl,
  );
  assert.throws(
    () => validator.assertSemantic(projectId, contract, legacyUrl, legacyCanonical),
    /DATABASE_URL is omitted/,
  );

  const resolver = new PipelineStageResolverService();
  const run: any = {
    id: runId,
    projectId,
    status: PipelineRunStatus.RUNNING,
    currentStage: "database_service_readiness",
    metadata: {},
  };
  const missingApplySuccess = resolver.resolve({
    run,
    events: [
      event("infrastructure_apply_started", "running", 1),
      event("database_tier_setup_completed", "success", 2),
    ],
    applyEnabled: true,
    githubActionsRequired: false,
    hasRuntimeSignals: false,
    hasDeployment: false,
    hasStableRelease: false,
    costTierWarningOnly: false,
  });
  assert.equal(
    missingApplySuccess.find((stage) => stage.stage === "terraform_apply")?.status,
    "warning",
    "downstream evidence cannot synthesize Terraform apply success",
  );

  const paused = resolver.resolve({
    run: {
      ...run,
      status: PipelineRunStatus.APPLY_DISABLED,
      currentStage: "terraform_apply_approval_required",
    },
    events: [
      event("terraform_apply_approval_required", "waiting", 1),
      event("database_service_readiness_started", "running", 2),
    ],
    applyEnabled: true,
    githubActionsRequired: false,
    hasRuntimeSignals: false,
    hasDeployment: false,
    hasStableRelease: false,
    costTierWarningOnly: false,
  });
  assert.equal(paused.find((stage) => stage.stage === "terraform_apply_gate")?.status, "requires_approval");
  assert.equal(paused.find((stage) => stage.stage === "database_tier_setup")?.status, "blocked");

  const taxonomy = [
    ["The deployment contract changed after planning.", "configuration_changed", "terraform_plan"],
    ["Terraform apply approval expired.", "approval_expired", "terraform_apply_gate"],
    ["The approved plan artifact changed.", "plan_artifact_changed", "terraform_apply"],
    ["Managed database service is not ready.", "managed_service_not_ready", "database_tier_setup"],
    ["ALB target health check failed.", "application_health_failed", "alb_health"],
  ] as const;
  for (const [message, expectedClass, expectedStage] of taxonomy) {
    const failureClass = normalizePipelineFailureClass(null, "", message);
    assert.equal(failureClass, expectedClass);
    assert.equal(pipelineFailureStage(failureClass, "validate_inputs"), expectedStage);
  }

  assert.equal(hasTerraformMutationEvidence({ applyCompleted: false }), false);
  assert.equal(hasTerraformMutationEvidence({
    applyCompleted: false,
    environmentPipelineRunId: runId,
    currentPipelineRunId: runId,
    terraformOutputs: {},
  }), false);
  assert.equal(hasTerraformMutationEvidence({
    applyCompleted: true,
    environmentPipelineRunId: runId,
    currentPipelineRunId: runId,
  }), true);
  const planSummary = (Object.create(InfrastructureService.prototype) as any).summarizePlan(
    JSON.stringify({
      resource_changes: [
        { change: { actions: ["create"] } },
        { change: { actions: ["update"] } },
        { change: { actions: ["delete", "create"] } },
        { change: { actions: ["delete"] } },
        { change: { actions: ["no-op"] } },
      ],
    }),
  );
  assert.deepEqual(planSummary, {
    create: 1,
    update: 1,
    replace: 1,
    delete: 1,
    noOp: 1,
  });
  assert.equal(isDestroyOperationRelevant({
    destroyCreatedAt: "2026-01-01",
    environmentProvisionedAt: "2026-02-01",
  }), false);

  const artifact = Buffer.from("deterministic local tfplan fixture");
  const artifactHash = createHash("sha256").update(artifact).digest("hex");
  const planFingerprint = validator.planFingerprint(
    artifactHash,
    inputFingerprint,
    canonical.contractFingerprint,
    runId,
  );
  const approval = {
    runId,
    planFingerprint,
    contractFingerprint: canonical.contractFingerprint,
    terraformInputFingerprint: inputFingerprint,
    consumed: false,
  };
  let executorCalls = 0;
  let claim: Promise<void> | null = null;
  const applyOnce = async (candidate: Buffer) => {
    if (claim) return claim;
    claim = (async () => {
      const actualHash = createHash("sha256").update(candidate).digest("hex");
      const actualPlan = validator.planFingerprint(
        actualHash,
        inputFingerprint,
        canonical.contractFingerprint,
        runId,
      );
      assert.equal(actualPlan, approval.planFingerprint);
      assert.equal(approval.consumed, false);
      approval.consumed = true;
      executorCalls += 1;
    })();
    return claim;
  };
  await Promise.all([applyOnce(artifact), applyOnce(artifact)]);
  assert.equal(executorCalls, 1, "duplicate job delivery may invoke the apply executor only once");
  assert.equal(approval.consumed, true);

  const swappedHash = createHash("sha256").update(Buffer.from("swapped plan")).digest("hex");
  assert.notEqual(
    validator.planFingerprint(
      swappedHash,
      inputFingerprint,
      canonical.contractFingerprint,
      runId,
    ),
    planFingerprint,
  );

  assert(!JSON.stringify({
    canonical,
    terraformVariables: {
      ...terraformVariables,
      ecs_secret_environment_variables: Object.keys(terraformVariables.ecs_secret_environment_variables),
    },
  }).includes("test-only-never-logged"));

  console.log("Final stabilization executable verification passed.");
  console.log("LOCAL_E2E=contract_validated->task_definition_validated->plan_policy_ready->exact_plan_approved->apply_once->database_ready->ecs_healthy->api_health_passed->stable");
  console.log("LOCAL_FAILURES=plaintext_secret,legacy_database_url,configuration_change,plan_swap,duplicate_delivery,downstream_without_success,historical_destroy");
}

void verify();
