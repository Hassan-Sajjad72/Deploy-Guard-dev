import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateDeploymentSideEffectJournal1760000039000 } from "../src/migrations/1760000039000-CreateDeploymentSideEffectJournal";
import { InactiveV1HandlerSideEffectSafetyService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-handler-side-effect-safety.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_6_effect_test_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe test schema identifier.");
}
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
  entities: [],
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

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createSchema() {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY)
  `);
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
    const migration =
      new CreateDeploymentSideEffectJournal1760000039000();
    await migration.up(runner);
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);
  } finally {
    await runner.release();
  }
}

async function seedFence(label: string) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const leaseId = randomUUID();
  const workerId = `session6.6-${label}`;
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
  const boundary = new InactiveV1HandlerSideEffectSafetyService(
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
  });
  return {
    projectId,
    intentId,
    leaseId,
    workerId,
    boundary,
    cancellation,
    loseTrust: () => {
      trusted = false;
    },
  };
}

function request(label: string, perform: (context: any) => Promise<any> | any) {
  return {
    operationId: randomUUID(),
    idempotencyKey: hash(`key:${label}`),
    effectType: `test.${label.replaceAll("_", ".")}`,
    inputFingerprint: hash(`input:${label}`),
    timeoutMs: 1_000,
    perform,
  };
}

async function effectRows(intentId: string) {
  return dataSource.query(
    `SELECT id, intent_id AS "intentId", operation_id AS "operationId",
            idempotency_key AS "idempotencyKey",
            request_fingerprint AS "requestFingerprint",
            lease_id AS "leaseId", owner_worker_id AS "workerId",
            fencing_token AS "fencingToken", status,
            safe_result_code AS "safeResultCode",
            result_fingerprint AS "resultFingerprint",
            external_reference_hash AS "externalReferenceHash",
            failure_code AS "failureCode",
            reconciliation_required AS "reconciliationRequired"
     FROM deployment_side_effects
     WHERE intent_id = $1 ORDER BY created_at`,
    [intentId],
  );
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();
    const service = new InactiveV1HandlerSideEffectSafetyService(dataSource);

    const successFence = await seedFence("success");
    let successExecutions = 0;
    const successRequest = request("successful_effect", async (context) => {
      successExecutions += 1;
      assert.equal(context.intentId, successFence.intentId);
      assert.equal(context.leaseId, successFence.leaseId);
      assert.equal(context.workerId, successFence.workerId);
      assert.equal(context.fencingToken, "1");
      assert.equal(context.isLeaseTrusted(), true);
      return {
        outcome: "succeeded",
        safeResultCode: "EFFECT_APPLIED",
        resultFingerprint: hash("success-result"),
        externalReferenceHash: hash("external-reference"),
      };
    });
    const succeeded = await successFence.boundary.execute(successRequest);
    assert.equal(succeeded.disposition, "executed");
    assert.equal(succeeded.effect.status, "succeeded");
    const [{ status: intentStillRunning }] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [successFence.intentId],
    );
    assert.equal(intentStillRunning, "running");
    const replayed = await successFence.boundary.execute(successRequest);
    assert.equal(replayed.disposition, "replayed");
    assert.equal(replayed.effect.id, succeeded.effect.id);
    assert.equal(successExecutions, 1);
    assert.deepEqual(successFence.boundary.finalizationStatus(), {
      allowed: true,
      safeFailureCode: null,
    });
    await assert.rejects(
      successFence.boundary.execute({
        ...successRequest,
        inputFingerprint: hash("different-input"),
      }),
      /SIDE_EFFECT_IDEMPOTENCY_CONFLICT/,
    );

    const concurrentFence = await seedFence("concurrent");
    let concurrentExecutions = 0;
    let effectStarted!: () => void;
    let releaseEffect!: () => void;
    const started = new Promise<void>((resolve) => {
      effectStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const concurrentRequest = request("concurrent_effect", async () => {
      concurrentExecutions += 1;
      effectStarted();
      await blocked;
      return {
        outcome: "succeeded",
        safeResultCode: "CONCURRENT_EFFECT_APPLIED",
        resultFingerprint: hash("concurrent-result"),
      };
    });
    const first = concurrentFence.boundary.execute(concurrentRequest);
    await started;
    const duplicate = await concurrentFence.boundary.execute(
      concurrentRequest,
    );
    assert.equal(duplicate.disposition, "in_progress");
    assert.equal(concurrentExecutions, 1);
    releaseEffect();
    assert.equal((await first).disposition, "executed");

    const rawError =
      "AccessKey=secret postgres://user:password@private-host/sdk-payload";
    const uncertainFence = await seedFence("uncertain");
    let uncertainExecutions = 0;
    const uncertainRequest = request("uncertain_effect", async () => {
      uncertainExecutions += 1;
      throw new Error(rawError);
    });
    const uncertain = await uncertainFence.boundary.execute(uncertainRequest);
    assert.equal(uncertain.disposition, "reconciliation_required");
    assert.equal(uncertain.effect.status, "uncertain");
    assert.equal(uncertain.effect.failureCode, "SIDE_EFFECT_OUTCOME_UNKNOWN");
    assert.deepEqual(uncertainFence.boundary.finalizationStatus(), {
      allowed: false,
      safeFailureCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
    });
    const uncertainJson = JSON.stringify(
      await effectRows(uncertainFence.intentId),
    );
    assert.equal(uncertainJson.includes(rawError), false);
    const uncertainReplay = await uncertainFence.boundary.execute(
      uncertainRequest,
    );
    assert.equal(
      uncertainReplay.disposition,
      "reconciliation_required",
    );
    assert.equal(uncertainExecutions, 1);

    const timeoutFence = await seedFence("timeout");
    const timeoutRequest = {
      ...request("timeout_effect", async () => {
        await wait(500);
        return {
          outcome: "succeeded",
          safeResultCode: "LATE_EFFECT",
          resultFingerprint: hash("late-result"),
        };
      }),
      timeoutMs: 100,
    };
    const timeoutStarted = Date.now();
    const timedOut = await timeoutFence.boundary.execute(timeoutRequest);
    assert.equal(timedOut.disposition, "reconciliation_required");
    if (timedOut.disposition === "reconciliation_required") {
      assert.equal(timedOut.reason, "execution_timed_out");
    }
    assert.ok(Date.now() - timeoutStarted < 400);
    assert.equal(timedOut.effect.failureCode, "SIDE_EFFECT_EXECUTION_TIMED_OUT");

    const cancelledFence = await seedFence("cancelled");
    let cancellationStarted!: () => void;
    const cancellationRunning = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const cancelledPromise = cancelledFence.boundary.execute(
      request("cancelled_effect", async (context) => {
        cancellationStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        return {
          outcome: "succeeded",
          safeResultCode: "MUST_NOT_WIN",
          resultFingerprint: hash("cancelled-result"),
        };
      }),
    );
    await cancellationRunning;
    cancelledFence.cancellation.abort();
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.disposition, "reconciliation_required");
    if (cancelled.disposition === "reconciliation_required") {
      assert.equal(cancelled.reason, "execution_cancelled");
    }

    const staleFence = await seedFence("stale");
    staleFence.loseTrust();
    await assert.rejects(
      staleFence.boundary.execute(request("blocked_effect", async () => ({
        outcome: "succeeded",
        safeResultCode: "MUST_NOT_RUN",
        resultFingerprint: hash("blocked"),
      }))),
      /SIDE_EFFECT_OWNERSHIP_LOST/,
    );
    assert.equal((await effectRows(staleFence.intentId)).length, 0);

    const replacedFence = await seedFence("replaced");
    let replacementStarted!: () => void;
    let releaseReplacement!: () => void;
    const replacementRunning = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replaced = replacedFence.boundary.execute(
      request("replaced_effect", async () => {
        replacementStarted();
        await replacementBlocked;
        return {
          outcome: "succeeded",
          safeResultCode: "STALE_SUCCESS",
          resultFingerprint: hash("stale-result"),
        };
      }),
    );
    await replacementRunning;
    await dataSource.query(
      `UPDATE project_operation_leases
       SET status = 'expired', expires_at = clock_timestamp()
       WHERE id = $1`,
      [replacedFence.leaseId],
    );
    await dataSource.query(
      `INSERT INTO project_operation_leases (
         id, project_id, environment_name, intent_id, owner_worker_id,
         fencing_token, status, expires_at
       ) VALUES (
         $1, $2, 'production', $3, $4, 2, 'heartbeat_active',
         clock_timestamp() + interval '1 hour'
       )`,
      [
        randomUUID(),
        replacedFence.projectId,
        replacedFence.intentId,
        "session6.6-replacement-owner",
      ],
    );
    replacedFence.loseTrust();
    releaseReplacement();
    const replacedResult = await replaced;
    assert.equal(replacedResult.disposition, "reconciliation_required");
    if (replacedResult.disposition === "reconciliation_required") {
      assert.equal(replacedResult.reason, "ownership_lost");
    }
    assert.equal(replacedResult.effect.status, "uncertain");
    assert.notEqual(replacedResult.effect.status, "succeeded");

    const reconciliation = await service.findReconciliationRequired({
      projectId: replacedFence.projectId,
      environmentName: "production",
    });
    assert.equal(reconciliation.length, 1);
    assert.equal(reconciliation[0].id, replacedResult.effect.id);

    const failedFence = await seedFence("failed");
    const failed = await failedFence.boundary.execute(
      request("known_failure", async () => ({
        outcome: "failed",
        safeFailureCode: "REMOTE_REQUEST_REJECTED",
      })),
    );
    assert.equal(failed.disposition, "failed");
    assert.equal(failed.effect.failureCode, "REMOTE_REQUEST_REJECTED");
    assert.equal(failed.effect.reconciliationRequired, false);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await assert.rejects(
        new CreateDeploymentSideEffectJournal1760000039000().down(runner),
        /Refusing to remove deployment side-effect reconciliation history/,
      );
    } finally {
      await runner.release();
    }

    console.log(
      "Inactive v1 handler side-effect safety isolated PostgreSQL verification passed",
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
