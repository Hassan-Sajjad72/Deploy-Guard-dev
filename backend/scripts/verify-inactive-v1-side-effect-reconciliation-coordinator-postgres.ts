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
import {
  InactiveV1SideEffectReconciliationCoordinatorService,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-side-effect-reconciliation-coordinator.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_8_coordinator_test_${suffix}`;
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
    await new CreateDeploymentSideEffectJournal1760000039000().up(runner);
    await new CreateSideEffectReconciliationJournal1760000040000().up(
      runner,
    );
  } finally {
    await runner.release();
  }
}

async function seedEffect(
  label: string,
  status:
    | "prepared"
    | "started"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "reconciled",
) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const operationLeaseId = randomUUID();
  const sideEffectId = randomUUID();
  const effectType = `test.${label.replaceAll("_", ".")}`;
  const workerId = `session6.8-origin-${label}`;
  await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, status
     ) VALUES ($1, $2, 'production', 'failed')`,
    [intentId, projectId],
  );
  await dataSource.query(
    `INSERT INTO project_operation_leases (
       id, project_id, environment_name, intent_id, owner_worker_id,
       fencing_token, status, expires_at
     ) VALUES (
       $1, $2, 'production', $3, $4, 1, 'expired',
       clock_timestamp() - interval '1 minute'
     )`,
    [operationLeaseId, projectId, intentId, workerId],
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
       clock_timestamp() - interval '1 minute',
       CASE WHEN $10::varchar IN (
         'uncertain','failed','succeeded','reconciled'
       ) THEN clock_timestamp() ELSE NULL END,
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
      operationLeaseId,
      workerId,
      status,
      status === "uncertain",
    ],
  );
  return {
    projectId,
    intentId,
    operationLeaseId,
    sideEffectId,
    effectType,
  };
}

async function verifyLegacyLeaseMigration() {
  const legacy = await seedEffect("legacy", "uncertain");
  const oldReconciliationLeaseId = legacy.operationLeaseId;
  await dataSource.query(
    `INSERT INTO deployment_side_effect_reconciliations (
       side_effect_id, intent_id, project_id, environment_name,
       operation_id, idempotency_key, adapter_id, request_fingerprint,
       lease_id, owner_worker_id, fencing_token, classification,
       safe_evidence_code, evidence_fingerprint,
       inspection_started_at, completed_at, created_at
     ) VALUES (
       $1, $2, $3, 'production', $4, $5, 'fixture.read-only', $6,
       $7, 'session6.7-legacy', 1, 'pending',
       'TARGET_EFFECT_STILL_PENDING', $8,
       clock_timestamp(), clock_timestamp(), clock_timestamp()
     )`,
    [
      legacy.sideEffectId,
      legacy.intentId,
      legacy.projectId,
      randomUUID(),
      hash("legacy-reconciliation-key"),
      hash("legacy-reconciliation-request"),
      oldReconciliationLeaseId,
      hash("legacy-evidence"),
    ],
  );
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const migration = new CreateSideEffectReconciliationLeases1760000041000();
  try {
    await migration.up(runner);
    await migration.up(runner);
    const [migrated] = await dataSource.query(
      `SELECT reconciliation.lease_id AS "leaseId",
              lease.origin, lease.legacy_operation_lease_id AS "legacyLeaseId"
       FROM deployment_side_effect_reconciliations reconciliation
       INNER JOIN deployment_side_effect_reconciliation_leases lease
         ON lease.id = reconciliation.lease_id
       WHERE reconciliation.side_effect_id = $1`,
      [legacy.sideEffectId],
    );
    assert.notEqual(migrated.leaseId, oldReconciliationLeaseId);
    assert.equal(migrated.origin, "legacy_backfill");
    assert.equal(migrated.legacyLeaseId, oldReconciliationLeaseId);

    await migration.down(runner);
    const [restored] = await dataSource.query(
      `SELECT lease_id AS "leaseId"
       FROM deployment_side_effect_reconciliations
       WHERE side_effect_id = $1`,
      [legacy.sideEffectId],
    );
    assert.equal(restored.leaseId, oldReconciliationLeaseId);
    await migration.up(runner);
  } finally {
    await runner.release();
  }
}

const reconciliation =
  new InactiveV1SideEffectReconciliationService(dataSource);
const coordinator =
  new InactiveV1SideEffectReconciliationCoordinatorService(
    dataSource,
    reconciliation,
  );

type Seed = Awaited<ReturnType<typeof seedEffect>>;

function request(
  seed: Seed,
  label: string,
  inspect: (context: any) => Promise<any> | any,
) {
  return {
    sideEffectId: seed.sideEffectId,
    operationId: randomUUID(),
    idempotencyKey: hash(`reconciliation-key:${label}`),
    inspectionFingerprint: hash(`inspection:${label}`),
    timeoutMs: 1_000,
    adapter: {
      policy:
        "deployguard.side-effect-reconciliation/read-only-v1" as const,
      adapterId: "fixture.read-only",
      effectType: seed.effectType,
      inspect,
    },
  };
}

async function effect(sideEffectId: string) {
  const [row] = await dataSource.query(
    `SELECT status, safe_result_code AS "safeResultCode",
            result_fingerprint AS "resultFingerprint",
            failure_code AS "failureCode",
            reconciliation_required AS "reconciliationRequired"
     FROM deployment_side_effects WHERE id = $1`,
    [sideEffectId],
  );
  return row;
}

async function leases(sideEffectId: string) {
  return dataSource.query(
    `SELECT id, owner_worker_id AS "workerId",
            fencing_token AS "fencingToken", status
     FROM deployment_side_effect_reconciliation_leases
     WHERE side_effect_id = $1 ORDER BY fencing_token`,
    [sideEffectId],
  );
}

async function journal(sideEffectId: string) {
  return dataSource.query(
    `SELECT id, lease_id AS "leaseId", classification,
            safe_evidence_code AS "safeEvidenceCode",
            evidence_fingerprint AS "evidenceFingerprint",
            result_fingerprint AS "resultFingerprint",
            failure_code AS "failureCode"
     FROM deployment_side_effect_reconciliations
     WHERE side_effect_id = $1 ORDER BY created_at`,
    [sideEffectId],
  );
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();
    await verifyLegacyLeaseMigration();

    const success = await seedEffect("success", "uncertain");
    let successInspections = 0;
    const successRequest = request(success, "success", async (context) => {
      successInspections += 1;
      assert.equal(context.readOnly, true);
      assert.equal(context.sideEffect.id, success.sideEffectId);
      assert.equal(context.fencingToken, "1");
      return {
        classification: "succeeded",
        safeEvidenceCode: "TARGET_EFFECT_CONFIRMED",
        evidenceFingerprint: hash("success-evidence"),
        resultFingerprint: hash("success-result"),
      };
    });
    const succeeded = await coordinator.coordinate({
      workerId: "session6.8-success",
      leaseTtlMs: 2_000,
      request: successRequest,
    });
    assert.equal(succeeded.disposition, "coordinated");
    if (succeeded.disposition === "coordinated") {
      assert.equal(succeeded.lease.fencingToken, "1");
      assert.equal(succeeded.lease.status, "released");
      assert.equal(succeeded.result.disposition, "classified");
    }
    assert.equal(successInspections, 1);
    assert.equal((await effect(success.sideEffectId)).status, "succeeded");
    const [{ status: successIntentStatus }] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [success.intentId],
    );
    assert.equal(successIntentStatus, "failed");

    const replayed = await coordinator.coordinate({
      workerId: "session6.8-replay",
      leaseTtlMs: 2_000,
      request: successRequest,
    });
    assert.equal(replayed.disposition, "terminal_evidence_replayed");
    assert.equal(successInspections, 1);
    assert.equal((await leases(success.sideEffectId)).length, 1);
    await assert.rejects(
      coordinator.coordinate({
        workerId: "session6.8-conflict",
        leaseTtlMs: 2_000,
        request: {
          ...successRequest,
          inspectionFingerprint: hash("changed-inspection"),
        },
      }),
      /RECONCILIATION_COORDINATOR_IDEMPOTENCY_CONFLICT/,
    );

    const nonTerminal = await seedEffect("non_terminal", "started");
    let nonTerminalInspections = 0;
    const pending = await coordinator.coordinate({
      workerId: "session6.8-pending",
      leaseTtlMs: 2_000,
      request: request(nonTerminal, "pending", async () => {
        nonTerminalInspections += 1;
        return {
          classification: "pending",
          safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
          evidenceFingerprint: hash("pending-evidence"),
        };
      }),
    });
    assert.equal(pending.disposition, "coordinated");
    assert.equal((await effect(nonTerminal.sideEffectId)).status, "uncertain");
    const manual = await coordinator.coordinate({
      workerId: "session6.8-manual",
      leaseTtlMs: 2_000,
      request: request(nonTerminal, "manual", async () => {
        nonTerminalInspections += 1;
        return {
          classification: "manual_review",
          safeFailureCode: "TARGET_EVIDENCE_AMBIGUOUS",
          evidenceFingerprint: hash("manual-evidence"),
        };
      }),
    });
    assert.equal(manual.disposition, "coordinated");
    assert.equal(nonTerminalInspections, 2);
    assert.deepEqual(
      (await leases(nonTerminal.sideEffectId)).map(
        (row: any) => String(row.fencingToken),
      ),
      ["1", "2"],
    );
    assert.equal(
      (await effect(nonTerminal.sideEffectId)).failureCode,
      "TARGET_EVIDENCE_AMBIGUOUS",
    );

    const concurrent = await seedEffect("concurrent", "uncertain");
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
    const first = coordinator.coordinate({
      workerId: "session6.8-concurrent-a",
      leaseTtlMs: 3_000,
      request: concurrentRequest,
    });
    await started;
    const duplicate = await coordinator.coordinate({
      workerId: "session6.8-concurrent-b",
      leaseTtlMs: 3_000,
      request: concurrentRequest,
    });
    assert.equal(duplicate.disposition, "inspection_in_progress");
    assert.equal(concurrentInspections, 1);
    assert.equal(
      (await leases(concurrent.sideEffectId)).filter(
        (row: any) => ["acquired", "heartbeat_active"].includes(row.status),
      ).length,
      1,
    );
    releaseInspection();
    assert.equal((await first).disposition, "coordinated");

    const abandoned = await seedEffect("abandoned", "started");
    const abandonedLeaseId = randomUUID();
    const abandonedReconciliationId = randomUUID();
    await dataSource.query(
      `INSERT INTO deployment_side_effect_reconciliation_leases (
         id, side_effect_id, intent_id, project_id, environment_name,
         owner_worker_id, fencing_token, status, origin,
         acquired_at, heartbeat_at, expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'production', 'session6.8-abandoned', 1,
         'acquired', 'coordinator',
         clock_timestamp() - interval '2 minutes',
         clock_timestamp() - interval '2 minutes',
         clock_timestamp() - interval '1 minute',
         clock_timestamp() - interval '2 minutes',
         clock_timestamp() - interval '2 minutes'
       )`,
      [
        abandonedLeaseId,
        abandoned.sideEffectId,
        abandoned.intentId,
        abandoned.projectId,
      ],
    );
    await dataSource.query(
      `INSERT INTO deployment_side_effect_reconciliations (
         id, side_effect_id, intent_id, project_id, environment_name,
         operation_id, idempotency_key, adapter_id, request_fingerprint,
         lease_id, owner_worker_id, fencing_token,
         inspection_started_at, created_at
       ) VALUES (
         $1, $2, $3, $4, 'production', $5, $6,
         'fixture.read-only', $7, $8, 'session6.8-abandoned', 1,
         clock_timestamp() - interval '2 minutes',
         clock_timestamp() - interval '2 minutes'
       )`,
      [
        abandonedReconciliationId,
        abandoned.sideEffectId,
        abandoned.intentId,
        abandoned.projectId,
        randomUUID(),
        hash("abandoned-old-key"),
        hash("abandoned-old-request"),
        abandonedLeaseId,
      ],
    );
    let reclaimedInspections = 0;
    const reclaimed = await coordinator.coordinate({
      workerId: "session6.8-reclaimed",
      leaseTtlMs: 2_000,
      request: request(abandoned, "reclaimed", async () => {
        reclaimedInspections += 1;
        return {
          classification: "pending",
          safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
          evidenceFingerprint: hash("reclaimed-evidence"),
        };
      }),
    });
    assert.equal(reclaimed.disposition, "coordinated");
    assert.equal(reclaimedInspections, 1);
    const abandonedRows = await journal(abandoned.sideEffectId);
    assert.equal(abandonedRows[0].classification, "pending");
    assert.equal(
      abandonedRows[0].safeEvidenceCode,
      "RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED",
    );
    assert.match(abandonedRows[0].evidenceFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      (await leases(abandoned.sideEffectId)).map(
        (row: any) => String(row.fencingToken),
      ),
      ["1", "2"],
    );

    const stale = await seedEffect("stale", "uncertain");
    let staleStarted!: () => void;
    let releaseStale!: () => void;
    const staleRunning = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleRequest = request(stale, "stale", async () => {
      staleStarted();
      await staleBlocked;
      return {
        classification: "succeeded",
        safeEvidenceCode: "STALE_EVIDENCE_MUST_NOT_WIN",
        evidenceFingerprint: hash("stale-evidence"),
        resultFingerprint: hash("stale-result"),
      };
    });
    const stalePromise = coordinator.coordinate({
      workerId: "session6.8-stale",
      leaseTtlMs: 3_000,
      request: staleRequest,
    });
    await staleRunning;
    await dataSource.query(
      `UPDATE deployment_side_effect_reconciliation_leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE side_effect_id = $1
         AND status IN ('acquired','heartbeat_active')`,
      [stale.sideEffectId],
    );
    const replacement = await coordinator.coordinate({
      workerId: "session6.8-replacement",
      leaseTtlMs: 2_000,
      request: request(stale, "replacement", async () => ({
        classification: "pending",
        safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
        evidenceFingerprint: hash("replacement-evidence"),
      })),
    });
    assert.equal(replacement.disposition, "coordinated");
    releaseStale();
    const staleResult = await stalePromise;
    assert.equal(staleResult.disposition, "coordinated");
    assert.notEqual((await effect(stale.sideEffectId)).status, "succeeded");
    assert.equal((await effect(stale.sideEffectId)).safeResultCode, null);
    assert.deepEqual(
      (await leases(stale.sideEffectId)).map(
        (row: any) => String(row.fencingToken),
      ),
      ["1", "2"],
    );

    const rawError =
      "AccessKey=secret postgres://user:password@private-host/sdk-payload";
    const sanitized = await seedEffect("sanitized", "uncertain");
    const sanitizedResult = await coordinator.coordinate({
      workerId: "session6.8-sanitized",
      leaseTtlMs: 2_000,
      request: request(sanitized, "sanitized", async () => {
        throw new Error(rawError);
      }),
    });
    assert.equal(sanitizedResult.disposition, "coordinated");
    assert.equal(
      JSON.stringify(await journal(sanitized.sideEffectId)).includes(rawError),
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
      const ineligible = await seedEffect(`ineligible_${status}`, status);
      let inspections = 0;
      const result = await coordinator.coordinate({
        workerId: `session6.8-ineligible-${status}`,
        leaseTtlMs: 2_000,
        request: request(ineligible, `ineligible_${status}`, async () => {
          inspections += 1;
          return {
            classification: "pending",
            safeEvidenceCode: "MUST_NOT_INSPECT",
            evidenceFingerprint: hash(`ineligible:${status}`),
          };
        }),
      });
      assert.equal(result.disposition, "effect_not_eligible");
      assert.equal(inspections, 0);
      assert.equal((await leases(ineligible.sideEffectId)).length, 0);
    }

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await assert.rejects(
        new CreateSideEffectReconciliationLeases1760000041000().down(
          runner,
        ),
        /Refusing to remove active reconciliation coordinator history/,
      );
    } finally {
      await runner.release();
    }

    console.log(
      "Inactive v1 reconciliation coordinator isolated PostgreSQL verification passed",
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
