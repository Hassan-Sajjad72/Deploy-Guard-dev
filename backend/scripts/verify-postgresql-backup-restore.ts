import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Snapshot = {
  tables: Record<string, { rows: number; fingerprint: string }>;
  sequences: Record<string, { lastValue: string; isCalled: boolean }>;
  migrations: { count: number; latest: string };
};

const repositoryRoot = resolve(__dirname, "../..");
const backendRoot = resolve(repositoryRoot, "backend");
const sourceDatabase = process.argv[2] || "";
const restoreDatabase = process.argv[3] || "";
const databaseUser = process.env.DATABASE_USERNAME || "mini_paas_user";

if (!/^[a-z][a-z0-9_]+$/.test(sourceDatabase)) throw new Error("PORTABILITY_SOURCE_DATABASE_REQUIRED");
if (!/^dg_portability_restore_[a-z0-9_]+$/.test(restoreDatabase)) throw new Error("PORTABILITY_DISPOSABLE_DATABASE_REQUIRED");
if (sourceDatabase === restoreDatabase || restoreDatabase === "mini_paas") throw new Error("PORTABILITY_DATABASE_IDENTITY_CONFLICT");

const archive = `/tmp/${restoreDatabase}.dump`;
let restoreCreated = false;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const safeError = String(result.stderr || result.stdout || "command failed")
      .replace(/password=[^\s]+/gi, "password=[REDACTED]")
      .slice(0, 4000);
    throw new Error(`${command} ${args[0] || ""} failed: ${safeError}`);
  }
  return String(result.stdout || "").trim();
}

function compose(args: string[]) {
  return run("docker", ["compose", ...args]);
}

function psql(database: string, sql: string) {
  return compose(["exec", "-T", "postgres", "psql", "-U", databaseUser, "-d", database, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql]);
}

function snapshot(database: string): Snapshot {
  const value = psql(database, `
    CREATE OR REPLACE FUNCTION pg_temp.deployguard_portability_snapshot()
    RETURNS jsonb LANGUAGE plpgsql AS \$function\$
    DECLARE
      table_row record;
      sequence_row record;
      row_count bigint;
      row_fingerprint text;
      sequence_last_value bigint;
      sequence_is_called boolean;
      table_result jsonb := '{}'::jsonb;
      sequence_result jsonb := '{}'::jsonb;
      migration_count bigint;
      migration_latest text;
    BEGIN
      FOR table_row IN
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> 'migrations'
         ORDER BY tablename
      LOOP
        EXECUTE format(
          'SELECT count(*), COALESCE(md5(string_agg(md5(to_jsonb(source_row)::text), '''' ORDER BY md5(to_jsonb(source_row)::text))), ''d41d8cd98f00b204e9800998ecf8427e'') FROM public.%I source_row',
          table_row.tablename
        ) INTO row_count, row_fingerprint;
        table_result := table_result || jsonb_build_object(table_row.tablename, jsonb_build_object('rows', row_count, 'fingerprint', row_fingerprint));
      END LOOP;
      FOR sequence_row IN
        SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename
      LOOP
        EXECUTE format('SELECT last_value, is_called FROM public.%I', sequence_row.sequencename)
          INTO sequence_last_value, sequence_is_called;
        sequence_result := sequence_result || jsonb_build_object(sequence_row.sequencename, jsonb_build_object('lastValue', sequence_last_value::text, 'isCalled', sequence_is_called));
      END LOOP;
      SELECT count(*), COALESCE(max(timestamp)::text, '') INTO migration_count, migration_latest FROM migrations;
      RETURN jsonb_build_object(
        'tables', table_result,
        'sequences', sequence_result,
        'migrations', jsonb_build_object('count', migration_count, 'latest', migration_latest)
      );
    END \$function\$;
    SELECT pg_temp.deployguard_portability_snapshot()::text;
  `);
  return JSON.parse(value) as Snapshot;
}

function runMigrationReplay(database: string) {
  const output = run("npm", ["run", "migration:run"], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_NAME: database },
  });
  assert.match(output, /No migrations are pending/);
}

async function main() {
  assert.equal(psql("postgres", `SELECT count(*) FROM pg_database WHERE datname = '${sourceDatabase}'`), "1", "source database must exist");
  assert.equal(psql("postgres", `SELECT count(*) FROM pg_database WHERE datname = '${restoreDatabase}'`), "0", "disposable restore database must not already exist");

  const sourceBefore = snapshot(sourceDatabase);
  compose(["exec", "-T", "postgres", "pg_dump", "-U", databaseUser, "-d", sourceDatabase, "--format=custom", "--no-owner", "--no-privileges", "--file", archive]);
  const archiveIdentity = compose(["exec", "-T", "postgres", "sha256sum", archive]).split(/\s+/)[0];
  assert.match(archiveIdentity, /^[a-f0-9]{64}$/);
  assert.ok(compose(["exec", "-T", "postgres", "pg_restore", "--list", archive]).split("\n").length > 10, "archive must contain a readable catalog");

  compose(["exec", "-T", "postgres", "createdb", "-U", databaseUser, restoreDatabase]);
  restoreCreated = true;
  compose(["exec", "-T", "postgres", "pg_restore", "-U", databaseUser, "-d", restoreDatabase, "--no-owner", "--no-privileges", "--exit-on-error", archive]);

  runMigrationReplay(restoreDatabase);
  runMigrationReplay(restoreDatabase);
  const restored = snapshot(restoreDatabase);
  const sourceAfter = snapshot(sourceDatabase);
  assert.deepEqual(sourceAfter, sourceBefore, "source database changed during read-only portability verification");
  assert.deepEqual(restored, sourceBefore, "restored database differs from source rows, fingerprints, sequences, or migrations");

  console.log(JSON.stringify({
    sourceDatabase,
    restoreDatabase,
    archiveSha256: archiveIdentity,
    tablesVerified: Object.keys(sourceBefore.tables).length,
    rowsVerified: Object.values(sourceBefore.tables).reduce((total, table) => total + table.rows, 0),
    sequencesVerified: Object.keys(sourceBefore.sequences).length,
    migrations: sourceBefore.migrations,
    migrationReplays: 2,
    sourceUnchanged: true,
    restoreEquivalent: true,
    archivePersisted: false,
  }));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    try {
      if (restoreCreated) {
        psql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${restoreDatabase}' AND pid <> pg_backend_pid()`);
        compose(["exec", "-T", "postgres", "dropdb", "-U", databaseUser, "--if-exists", restoreDatabase]);
      }
    } finally {
      compose(["exec", "-T", "postgres", "rm", "-f", archive]);
    }
  });
