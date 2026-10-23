# DeployGuard deployment operations runbook

## Scope and safety boundary

This runbook covers the DeployGuard control-plane PostgreSQL database and the
normal-v1 local runtime. It does not claim an AWS Backup recovery point, EFS
restore, Stripe checkout or SNS delivery. Cloud storage recovery remains a
separately authorized provider operation.

Stripe and SNS are deferred productization work. Keep these values off:

```text
BILLING_PROVIDER_ENABLED=false
NOTIFICATION_DELIVERY_ENABLED=false
```

## PostgreSQL backup and portability verification

Prerequisites: the repository PostgreSQL service is healthy, the source
database is quiescent, and no migration or worker is active. The target name
must begin with `dg_portability_restore_` and must not already exist.

```bash
docker compose up -d postgres
cd backend
npm run test:postgresql-backup-restore -- mini_paas dg_portability_restore_YYYYMMDD
```

The command:

1. records every application-table row count and complete deterministic row
   fingerprint, all public sequence positions, and migration identity;
2. creates a custom-format dump inside the PostgreSQL container;
3. verifies its SHA-256 and `pg_restore --list` readability;
4. restores into the exact disposable target;
5. requires two migration replays to report no pending migrations;
6. compares the restored database with the source and rechecks that the source
   did not change; and
7. terminates only target sessions, drops only the disposable target, and
   deletes the temporary archive.

The archive is deliberately not persisted by this verifier because it can
contain encrypted application records and other sensitive operational data.
Production backup retention requires encrypted restricted storage, an access
audit, retention policy, and a separately scheduled restore exercise.

## Recovery decision order

1. Stop API mutation routes, dispatchers and workers; record their prior state.
2. Inspect PostgreSQL sessions, migration version, Redis queues, outbox claims,
   operation leases and cross-lane ownership before changing anything.
3. Verify the backup checksum and catalog before creating a restore target.
4. Restore into a new database; never overwrite the source during validation.
5. Compare migrations, rows, fingerprints and sequences, then run focused
   authentication, planning, ownership, current-state and UI regressions.
6. Change application connectivity only through an explicitly approved
   cutover. Preserve the old database until rollback expiry.
7. After verification, stop temporary processes and remove disposable database,
   archive, Redis prefix and local ports.

## Normal-v1 local runtime

Use the repository-owned lifecycle commands:

```bash
npm run demo:normal-v1-local -- start
npm run demo:normal-v1-local -- status
npm run demo:normal-v1-local -- stop
```

Production execution remains default-off. A local fixture result is not live
AWS evidence.

## AWS/EFS limitation

`BackupService` currently persists backup-plan visibility and an
approval-oriented restore request. It does not execute an AWS restore. A real
EFS or managed-database recovery requires exact recovery-point identity,
provider credentials, isolated target verification, application consistency
checks and explicit mutation authorization. Do not mark a request completed
from the presence of a durable row alone.
