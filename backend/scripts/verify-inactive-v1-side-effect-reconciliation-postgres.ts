import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import {
  CreateDeploymentSideEffectJournal1760000039000,
} from "../src/migrations/1760000039000-CreateDeploymentSideEffectJournal";
import {
  CreateSideEffectReconciliationJournal1760000040000,
} from "../src/migrations/1760000040000-CreateSideEffectReconciliationJournal";
import {
  CreateSideEffectReconciliationLeases1760000041000,
} from "../src/migrations/1760000041000-CreateSideEffectReconciliationLeases";
import {
  InactiveV1SideEffectReconciliationService,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-side-effect-reconciliation.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_7_reconciliation_test_${suffix}`;
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

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    const effects = new CreateDeploymentSideEffectJournal1760000039000();
    const reconciliations =
      new CreateSideEffectReconciliationJournal1760000040000();
    const leases = new CreateSideEffectReconciliationLeases1760000041000();
    await effects.up(runner);
    await effects.up(runner);
    await reconciliations.up(runner);
    await reconciliations.up(runner);
    await leases.up(runner);
    await leases.up(runner);
    await leases.down(runner);
    await reconciliations.down(runner);
    await effects.down(runner);
    await effects.up(runner);
    await reconciliations.up(runner);
    await leases.up(runner);
  } finally {
    await runner.release();
  }
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(
  label: string,
  effectStatus:
    | "prepared"
    | "started"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "reconciled",
) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const leaseId = randomUUID();
  const sideEffectId = randomUUID();
  const workerId = `session6.7-${label}`;
  const effectType = `test.${label.replaceAll("_", ".")}`;
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
  await dataSource.query(
    `INSERT INTO deployment_side_effects (
       id, intent_id, project_id, environment_name, operation_id,
       effect_type, idempotency_key, request_fingerprint,
       lease_id, owner_worker_id, fencing_token, status,
       reconciliation_required, attempt_started_at, deadline_at,
       completed_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'production', $4, $5, $6, $7,
       $8, $9, 1, $10::varchar, $11, clock_timestamp(),
       clock_timestamp() + interval '5 minutes',
       CASE WHEN $10::varchar IN ('uncertain','failed','succeeded')
         THEN clock_timestamp() ELSE NULL END,
       clock_timestamp(), clock_timestamp()
     )`,
    [
      sideEffectId,
      intentId,
      projectId,
      randomUUID(),
      effectType,
      hash(`effect-key:${label}`),
      hash(`effect-request:${label}`),
      leaseId,
      workerId,
      effectStatus,
      effectStatus === "uncertain",
    ],
  );
  await dataSource.query(
    `INSERT INTO deployment_side_effect_reconciliation_leases (
       id, side_effect_id, intent_id, project_id, environment_name,
       owner_worker_id, fencing_token, status, origin,
       acquired_at, heartbeat_at, expires_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'production', $5, 1, 'heartbeat_active',
       'coordinator', clock_timestamp(), clock_timestamp(),
       clock_timestamp() + interval '1 hour',
       clock_timestamp(), clock_timestamp()
     )`,
    [leaseId, sideEffectId, intentId, projectId, workerId],
  );
  let trusted = true;
  const cancellation = new AbortController();
  const service = new InactiveV1SideEffectReconciliationService(dataSource);
  const boundary = service.forOwnership({
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
    sideEffectId,
    workerId,
    effectType,
    boundary,
    loseTrust: () => {
      trusted = false;
    },
  };
}

function request(
  seedValue: Seed,
  label: string,
  inspect: (context: any) => Promise<any> | any,
) {
  return {
    sideEffectId: seedValue.sideEffectId,
    operationId: randomUUID(),
    idempotencyKey: hash(`reconciliation-key:${label}`),
    inspectionFingerprint: hash(`inspection:${label}`),
    timeoutMs: 1_000,
    adapter: {
      policy:
        "deployguard.side-effect-reconciliation/read-only-v1" as const,
      adapterId: "fixture.read-only",
      effectType: seedValue.effectType,
      inspect,
    },
  };
}

async function effect(sideEffectId: string) {
  const [row] = await dataSource.query(
    `SELECT status, safe_result_code AS "safeResultCode",
            result_fingerprint AS "resultFingerprint",
            external_reference_hash AS "externalReferenceHash",
            failure_code AS "failureCode",
            reconciliation_required AS "reconciliationRequired"
     FROM deployment_side_effects WHERE id = $1`,
    [sideEffectId],
  );
  return row;
}

async function reconciliations(sideEffectId: string) {
  return dataSource.query(
    `SELECT id, lease_id AS "leaseId",
            owner_worker_id AS "workerId",
            fencing_token AS "fencingToken", classification,
            safe_evidence_code AS "safeEvidenceCode",
            evidence_fingerprint AS "evidenceFingerprint",
            result_fingerprint AS "resultFingerprint",
            external_reference_hash AS "externalReferenceHash",
            failure_code AS "failureCode"
     FROM deployment_side_effect_reconciliations
     WHERE side_effect_id = $1 ORDER BY created_at`,
    [sideEffectId],
  );
}

async function replaceLease(seedValue: Seed) {
  const leaseId = randomUUID();
  const workerId = `${seedValue.workerId}-replacement`;
  await dataSource.query(
    `UPDATE project_operation_leases
     SET status = 'expired', expires_at = clock_timestamp()
     WHERE id = $1`,
    [seedValue.leaseId],
  );
  await dataSource.query(
    `UPDATE deployment_side_effect_reconciliation_leases
     SET status = 'expired', expires_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE id = $1`,
    [seedValue.leaseId],
  );
  await dataSource.query(
    `INSERT INTO project_operation_leases (
       id, project_id, environment_name, intent_id, owner_worker_id,
       fencing_token, status, expires_at
     ) VALUES (
       $1, $2, 'production', $3, $4, 2, 'heartbeat_active',
       clock_timestamp() + interval '1 hour'
     )`,
    [leaseId, seedValue.projectId, seedValue.intentId, workerId],
  );
  await dataSource.query(
    `INSERT INTO deployment_side_effect_reconciliation_leases (
       id, side_effect_id, intent_id, project_id, environment_name,
       owner_worker_id, fencing_token, status, origin,
       acquired_at, heartbeat_at, expires_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'production', $5, 2, 'heartbeat_active',
       'coordinator', clock_timestamp(), clock_timestamp(),
       clock_timestamp() + interval '1 hour',
       clock_timestamp(), clock_timestamp()
     )`,
    [
      leaseId,
      seedValue.sideEffectId,
      seedValue.intentId,
      seedValue.projectId,
      workerId,
    ],
  );
  return {
    leaseId,
    workerId,
    boundary: new InactiveV1SideEffectReconciliationService(
      dataSource,
    ).forOwnership({
      intentId: seedValue.intentId,
      projectId: seedValue.projectId,
      environmentName: "production",
      leaseId,
      workerId,
      fencingToken: "2",
      signal: new AbortController().signal,
      isLeaseTrusted: () => true,
    }),
  };
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();

    const success = await seed("success", "uncertain");
    let successInspections = 0;
    const successRequest = request(success, "success", async (context) => {
      successInspections += 1;
      assert.equal(context.readOnly, true);
      assert.equal(context.sideEffect.id, success.sideEffectId);
      assert.equal(context.intentId, success.intentId);
      assert.equal(context.leaseId, success.leaseId);
      assert.equal(context.workerId, success.workerId);
      assert.equal(context.fencingToken, "1");
      assert.equal(context.isLeaseTrusted(), true);
      return {
        classification: "succeeded",
        safeEvidenceCode: "TARGET_EFFECT_CONFIRMED",
        evidenceFingerprint: hash("success-evidence"),
        resultFingerprint: hash("success-result"),
        externalReferenceHash: hash("success-reference"),
      };
    });
    const succeeded = await success.boundary.reconcile(successRequest);
    assert.equal(succeeded.disposition, "classified");
    assert.equal(succeeded.classification, "succeeded");
    assert.equal(succeeded.sideEffect.status, "succeeded");
    assert.equal(successInspections, 1);
    const [{ status: intentStillRunning }] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [success.intentId],
    );
    assert.equal(intentStillRunning, "running");
    const successReplay = await success.boundary.reconcile(successRequest);
    assert.equal(successReplay.disposition, "replayed");
    assert.equal(successReplay.classification, "succeeded");
    assert.equal(successInspections, 1);
    await assert.rejects(
      success.boundary.reconcile({
        ...successRequest,
        inspectionFingerprint: hash("changed-inspection"),
      }),
      /SIDE_EFFECT_RECONCILIATION_IDEMPOTENCY_CONFLICT/,
    );

    const knownFailure = await seed("known_failure", "started");
    const failed = await knownFailure.boundary.reconcile(
      request(knownFailure, "known_failure", async () => ({
        classification: "failed",
        safeFailureCode: "TARGET_EFFECT_REJECTED",
        evidenceFingerprint: hash("failure-evidence"),
      })),
    );
    assert.equal(failed.reconciliation.classification, "failed");
    assert.equal((await effect(knownFailure.sideEffectId)).status, "failed");
    assert.equal(
      (await effect(knownFailure.sideEffectId)).failureCode,
      "TARGET_EFFECT_REJECTED",
    );

    const pending = await seed("pending", "started");
    const pendingResult = await pending.boundary.reconcile(
      request(pending, "pending", async () => ({
        classification: "pending",
        safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
        evidenceFingerprint: hash("pending-evidence"),
      })),
    );
    assert.equal(pendingResult.reconciliation.classification, "pending");
    assert.equal((await effect(pending.sideEffectId)).status, "uncertain");
    assert.equal(
      (await effect(pending.sideEffectId)).reconciliationRequired,
      true,
    );

    const rawError =
      "AccessKey=secret postgres://user:password@private-host/sdk-payload";
    const manual = await seed("manual_review", "uncertain");
    const manualResult = await manual.boundary.reconcile(
      request(manual, "manual_review", async () => {
        throw new Error(rawError);
      }),
    );
    assert.equal(
      manualResult.reconciliation.classification,
      "manual_review",
    );
    assert.equal(manualResult.sideEffect.status, "uncertain");
    assert.equal(
      JSON.stringify(await reconciliations(manual.sideEffectId)).includes(
        rawError,
      ),
      false,
    );

    for (
      const status of [
        "prepared",
        "succeeded",
        "failed",
        "reconciled",
      ] as const
    ) {
      const ineligible = await seed(`ineligible_${status}`, status);
      let inspections = 0;
      await assert.rejects(
        ineligible.boundary.reconcile(
          request(ineligible, `ineligible_${status}`, async () => {
            inspections += 1;
            return {
              classification: "pending",
              safeEvidenceCode: "MUST_NOT_INSPECT",
              evidenceFingerprint: hash(`ineligible:${status}`),
            };
          }),
        ),
        /SIDE_EFFECT_RECONCILIATION_EFFECT_NOT_ELIGIBLE/,
      );
      assert.equal(inspections, 0);
    }

    const concurrent = await seed("concurrent", "uncertain");
    let concurrentInspections = 0;
    let inspectionStarted!: () => void;
    let releaseInspection!: () => void;
    const started = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const concurrentRequest = request(
      concurrent,
      "concurrent",
      async () => {
        concurrentInspections += 1;
        inspectionStarted();
        await blocked;
        return {
          classification: "pending",
          safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
          evidenceFingerprint: hash("concurrent-evidence"),
        };
      },
    );
    const first = concurrent.boundary.reconcile(concurrentRequest);
    await started;
    const duplicate = await concurrent.boundary.reconcile(concurrentRequest);
    assert.equal(duplicate.disposition, "inspection_in_progress");
    assert.equal(concurrentInspections, 1);
    releaseInspection();
    assert.equal((await first).reconciliation.classification, "pending");

    const stale = await seed("stale", "uncertain");
    const replacement = await replaceLease(stale);
    let staleInspections = 0;
    await assert.rejects(
      stale.boundary.reconcile(request(stale, "stale", async () => {
        staleInspections += 1;
        return {
          classification: "succeeded",
          safeEvidenceCode: "MUST_NOT_WIN",
          evidenceFingerprint: hash("stale-evidence"),
          resultFingerprint: hash("stale-result"),
        };
      })),
      /SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST/,
    );
    assert.equal(staleInspections, 0);
    const replacementResult = await replacement.boundary.reconcile(
      request(stale, "replacement", async () => ({
        classification: "pending",
        safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
        evidenceFingerprint: hash("replacement-evidence"),
      })),
    );
    assert.equal(
      replacementResult.reconciliation.classification,
      "pending",
    );

    const ownershipLost = await seed("ownership_lost", "uncertain");
    let lostInspectionStarted!: () => void;
    let releaseLostInspection!: () => void;
    const lostStarted = new Promise<void>((resolve) => {
      lostInspectionStarted = resolve;
    });
    const lostBlocked = new Promise<void>((resolve) => {
      releaseLostInspection = resolve;
    });
    const lostPromise = ownershipLost.boundary.reconcile(
      request(ownershipLost, "ownership_lost", async () => {
        lostInspectionStarted();
        await lostBlocked;
        return {
          classification: "succeeded",
          safeEvidenceCode: "STALE_EVIDENCE_MUST_NOT_WIN",
          evidenceFingerprint: hash("lost-evidence"),
          resultFingerprint: hash("lost-result"),
        };
      }),
    );
    await lostStarted;
    await replaceLease(ownershipLost);
    ownershipLost.loseTrust();
    releaseLostInspection();
    const lostResult = await lostPromise;
    assert.equal(lostResult.reconciliation.classification, "pending");
    assert.equal(lostResult.sideEffect.status, "uncertain");
    assert.equal(
      (await effect(ownershipLost.sideEffectId)).safeResultCode,
      null,
    );

    const timeout = await seed("timeout", "started");
    const timeoutStarted = Date.now();
    const timeoutResult = await timeout.boundary.reconcile({
      ...request(timeout, "timeout", async () => {
        await wait(500);
        return {
          classification: "succeeded",
          safeEvidenceCode: "LATE_EVIDENCE_MUST_NOT_WIN",
          evidenceFingerprint: hash("late-evidence"),
          resultFingerprint: hash("late-result"),
        };
      }),
      timeoutMs: 100,
    });
    assert.ok(Date.now() - timeoutStarted < 400);
    assert.equal(timeoutResult.reconciliation.classification, "pending");
    assert.equal(timeoutResult.sideEffect.status, "uncertain");

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await assert.rejects(
        new CreateSideEffectReconciliationJournal1760000040000().down(
          runner,
        ),
        /Refusing to remove side-effect reconciliation evidence/,
      );
    } finally {
      await runner.release();
    }

    console.log(
      "Inactive v1 side-effect reconciliation isolated PostgreSQL verification passed",
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
