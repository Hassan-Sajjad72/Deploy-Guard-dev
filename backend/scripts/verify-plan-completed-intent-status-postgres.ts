import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import {
  DEPLOYMENT_INTENT_STATUSES,
  DeploymentIntentStatus,
} from "../src/orchestration-contracts/contracts/deployment-intent.types";
import {
  AddPlanCompletedDeploymentIntentStatus1760000049000,
} from "../src/migrations/1760000049000-AddPlanCompletedDeploymentIntentStatus";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `plan_completed_status_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");

const prior = [
  "received", "planned", "enqueued", "running", "completed",
  "failed", "cancelled", "no_op", "rejected",
] as const;
const migration = new AddPlanCompletedDeploymentIntentStatus1760000049000();
const dataSource = new DataSource({
  ...AppDataSource.options,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);

async function rejectsStatus(
  query: (sql: string, values?: unknown[]) => Promise<unknown>,
  status: string,
) {
  await assert.rejects(
    () => query(
      `INSERT INTO "deployment_intents" ("status") VALUES ($1)`,
      [status],
    ),
    /CHK_deployment_intent_status|violates check constraint/,
  );
}

async function main() {
  const typed: DeploymentIntentStatus = "plan_completed";
  assert.equal(typed, "plan_completed");
  assert.deepEqual(DEPLOYMENT_INTENT_STATUSES, [
    "received", "planned", "enqueued", "running", "plan_completed",
    "completed", "failed", "cancelled", "no_op", "rejected",
  ]);

  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}", public`);
    await runner.query(`
      CREATE TABLE "deployment_intents" (
        "id" bigserial PRIMARY KEY,
        "status" varchar(32) NOT NULL,
        CONSTRAINT "CHK_deployment_intent_status"
          CHECK ("status" IN (
            'received','planned','enqueued','running','completed',
            'failed','cancelled','no_op','rejected'
          ))
      )
    `);
    for (const status of prior) {
      await runner.query(
        `INSERT INTO "deployment_intents" ("status") VALUES ($1)`,
        [status],
      );
    }
    const before = await runner.query(
      `SELECT "id", "status" FROM "deployment_intents" ORDER BY "id"`,
    );
    await rejectsStatus(runner.query.bind(runner), "plan_completed");

    await migration.up(runner);
    assert.deepEqual(
      await runner.query(
        `SELECT "id", "status" FROM "deployment_intents" ORDER BY "id"`,
      ),
      before,
    );
    await runner.query(
      `INSERT INTO "deployment_intents" ("status") VALUES ('plan_completed')`,
    );
    await rejectsStatus(runner.query.bind(runner), "invented_status");

    await assert.rejects(
      () => migration.down(runner),
      /Refusing to remove plan_completed/,
    );
    await runner.query(
      `DELETE FROM "deployment_intents" WHERE "status" = 'plan_completed'`,
    );
    await migration.down(runner);
    assert.deepEqual(
      await runner.query(
        `SELECT "id", "status" FROM "deployment_intents" ORDER BY "id"`,
      ),
      before,
    );
    await rejectsStatus(runner.query.bind(runner), "plan_completed");
    await rejectsStatus(runner.query.bind(runner), "invented_status");
    console.log(
      "plan_completed deployment-intent status migration verification passed",
    );
  } finally {
    await runner.query(`SET search_path TO public`);
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runner.release();
    await dataSource.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
