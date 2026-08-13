import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { INestApplication, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { InactiveV1BullMqConsumerService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service";
import { InactiveV1ReleaseLaneCompositionService } from "../src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition";
import { ProductionV1ReleaseCanaryPreflightService } from "../src/orchestration-contracts/release-lane/production-v1-release-canary-preflight.service";

const projectId = "92000000-0000-4000-8000-000000000001";
const schema = `operational_9_2_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const keys = [
  "NODE_ENV", "TYPEORM_SYNCHRONIZE", "PGOPTIONS", "AWS_EC2_METADATA_DISABLED",
  "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED", "TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED",
  "TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST", "TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST",
  "TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED", "TWO_LANE_RELEASE_COMPOSITION_ENABLED",
  "TWO_LANE_RELEASE_COMPOSITION_MODE", "TWO_LANE_RELEASE_WORKER_ID",
  "TWO_LANE_RELEASE_PROJECT_ALLOWLIST", "TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST",
  "TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED", "TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE",
  "TWO_LANE_CANARY_ECR_REPOSITORY", "TWO_LANE_CANARY_ECS_CLUSTER",
  "TWO_LANE_CANARY_ECS_SERVICE", "TWO_LANE_CANARY_TARGET_GROUP",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const base = AppDataSource.options as DataSourceOptions;
let admin: DataSource | null = null;
let app: INestApplication | null = null;

async function close() {
  await app?.close().catch(() => undefined);
  app = null;
  if (admin?.isInitialized) await admin.destroy().catch(() => undefined);
  admin = null;
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

void (async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    TYPEORM_SYNCHRONIZE: "true",
    PGOPTIONS: `-c search_path=${schema},public`,
    AWS_EC2_METADATA_DISABLED: "true",
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
    TWO_LANE_RELEASE_WORKER_ID: "canary-read-only-worker",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE: "read_only",
    TWO_LANE_CANARY_ECR_REPOSITORY: "",
    TWO_LANE_CANARY_ECS_CLUSTER: "",
    TWO_LANE_CANARY_ECS_SERVICE: "",
    TWO_LANE_CANARY_TARGET_GROUP: "",
  });
  admin = new DataSource({ ...base, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const { AppModule } = await import("../src/app.module");
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.init();
  const composition = app.get(InactiveV1ReleaseLaneCompositionService);
  const consumer = app.get(InactiveV1BullMqConsumerService);
  assert.equal(composition.getStatus().state, "ready");
  assert.equal(composition.getStatus().mode, "production_canary");
  assert.equal(consumer.isStarted(), false);
  assert.equal(composition.getInactiveComposition()?.consumer.isStarted(), false);
  const preflight = app.get(ProductionV1ReleaseCanaryPreflightService);
  const result = await preflight.run();
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.safeCodes, ["CANARY_RESOURCE_CONFIGURATION_INVALID"]);
  const owners = await app.get(DataSource).query("SELECT COUNT(*)::int AS count FROM project_release_lane_ownerships");
  assert.equal(Number(owners[0].count), 0);
  console.log("Operational production canary normal-runtime verification passed.");
})().catch((error) => {
  Logger.error(error instanceof Error ? error.message : "verification failed");
  process.exitCode = 1;
}).finally(close);
