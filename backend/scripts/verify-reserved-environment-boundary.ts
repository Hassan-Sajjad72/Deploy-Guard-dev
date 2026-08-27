import "reflect-metadata";
import { strict as assert } from "node:assert";
import { BadRequestException } from "@nestjs/common";
import { ProjectsService } from "../src/projects/projects.service";
import { partitionSubmittedEnvironmentVariables } from "../src/projects/configuration-ownership";

const contract = { requiredEnvVars: [], optionalEnvVars: [], persistentStorageRequired: false };
const service = new ProjectsService(
  {} as never, {} as never, {} as never,
  { findOne: async () => null } as never,
  {} as never, {} as never, {} as never, {} as never,
  { getForProject: async () => contract } as never,
  {} as never, {} as never, {} as never, {} as never,
);

async function structuredFailure(work: () => Promise<unknown> | unknown, key: string) {
  try {
    await work();
    assert.fail(`${key} must be rejected`);
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    const response = error.getResponse() as Record<string, unknown>;
    assert.equal(response.code, "RESERVED_ENVIRONMENT_VARIABLE");
    assert.equal(response.key, key);
    assert.equal(response.managedBy, "DeployGuard");
    assert.doesNotMatch(JSON.stringify(response), /secret-value|token-value/);
  }
}

async function run() {
  const ownership = (service as unknown as { assertEnvironmentOwnership(projectId: string, key: string): Promise<void> }).assertEnvironmentOwnership.bind(service);
  const mutable = (service as unknown as { assertVariableMutable(variable: Record<string, unknown>): void }).assertVariableMutable.bind(service);
  for (const [action, key] of [["create", "PORT"], ["edit", "AWS_REGION"], ["override", "DATABASE_URL"]] as const) {
    await structuredFailure(() => ownership("project-id", key), key);
    assert.ok(action);
  }
  const bulk = partitionSubmittedEnvironmentVariables([
    { key: "DEPLOYGUARD_PROJECT_ID", value: "must-not-survive" },
    { key: "APP_SECRET", value: "application-value" },
  ]);
  assert.deepEqual(bulk.ignoredVariableNames, ["DEPLOYGUARD_PROJECT_ID"]);
  assert.deepEqual(bulk.accepted.map((item) => item.key), ["APP_SECRET"]);
  assert.doesNotMatch(JSON.stringify(bulk), /must-not-survive/);
  await structuredFailure(() => mutable({ key: "HOST", normalizedKey: "HOST", isRequired: true, protected: true, owner: "platform" }), "HOST");
  await structuredFailure(() => mutable({ key: "DB_PASSWORD", normalizedKey: "DB_PASSWORD", isRequired: true, protected: true, owner: "managed_service" }), "DB_PASSWORD");
  assert.doesNotThrow(() => mutable({ key: "FEATURE_FLAG", normalizedKey: "FEATURE_FLAG", isRequired: false, protected: false, owner: "user_optional" }));
  console.log("Reserved environment create/edit/delete boundaries fail closed while bulk input ignores managed names without retaining values");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
