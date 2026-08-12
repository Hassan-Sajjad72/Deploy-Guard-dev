import "reflect-metadata";
import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";

const databaseName = `deployguard_extinction_test_${Date.now()}`;
if (!/^[a-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe temporary database name.");

async function main() {
  const admin = new DataSource({ ...AppDataSource.options, migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  let isolated: DataSource | null = null;
  await admin.initialize();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    isolated = new DataSource({ ...AppDataSource.options, database: databaseName, synchronize: false, logging: false } as DataSourceOptions);
    await isolated.initialize();
    const migrations = await isolated.runMigrations({ transaction: "all" });
    assert.ok(migrations.some((item) => item.name === "ProjectExtinctionCascade1760000068000"));
    assert.ok(migrations.some((item) => item.name === "ValidateProjectExtinctionOwnership1760000069000"));
    assert.ok(migrations.some((item) => item.name === "SeparateLegacyGithubAdministrators1760000070000"));
    const [projectCoverage] = await isolated.query(`
      WITH columns AS (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='project_id' AND table_name <> 'projects'
      ), cascades AS (
        SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.referential_constraints rc USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.constraint_column_usage ccu USING (constraint_catalog, constraint_schema, constraint_name)
        WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
          AND kcu.column_name='project_id' AND ccu.table_name='projects' AND rc.delete_rule='CASCADE'
      )
      SELECT (SELECT count(*)::int FROM columns) AS total,
             (SELECT count(*)::int FROM columns c JOIN cascades f USING(table_name)) AS covered
    `);
    assert.ok(projectCoverage.total > 0);
    assert.equal(projectCoverage.covered, projectCoverage.total, "every project-scoped table cascades from the project root");
    const [generationCoverage] = await isolated.query(`
      WITH columns AS (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='generation_id' AND table_name <> 'project_deployment_generations'
      ), cascades AS (
        SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.referential_constraints rc USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.constraint_column_usage ccu USING (constraint_catalog, constraint_schema, constraint_name)
        WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
          AND kcu.column_name='generation_id' AND ccu.table_name='project_deployment_generations' AND rc.delete_rule='CASCADE'
      )
      SELECT (SELECT count(*)::int FROM columns) AS total,
             (SELECT count(*)::int FROM columns c JOIN cascades f USING(table_name)) AS covered
    `);
    assert.equal(generationCoverage.covered, generationCoverage.total, "every generation-scoped table cascades from its project generation");
    const textColumnGroups = await isolated.query(`
      SELECT source.table_name AS "tableName", json_agg(source.column_name ORDER BY source.ordinal_position) AS columns
      FROM information_schema.columns source
      WHERE source.table_schema = 'public'
        AND source.data_type IN ('uuid', 'text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
      GROUP BY source.table_name
      ORDER BY source.table_name
    `) as Array<{ tableName: string; columns: unknown }>;
    assert.ok(textColumnGroups.length > 0);
    assert.ok(textColumnGroups.every((item) => Array.isArray(item.columns)), "extinction identity discovery receives driver-stable column arrays");
    const aiCascade = await isolated.query(`
      SELECT tc.table_name FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc USING (constraint_catalog, constraint_schema, constraint_name)
      WHERE tc.table_schema='public' AND tc.constraint_name IN ('fk_ext_ai_messages_session','fk_ext_ai_results_session')
        AND rc.delete_rule='CASCADE'
    `);
    assert.equal(aiCascade.length, 2, "AI session children cannot survive deletion of their project session");
    const [unvalidated] = await isolated.query(`SELECT count(*)::int AS count FROM pg_constraint WHERE conname LIKE 'fk_ext_%' AND NOT convalidated`);
    assert.equal(unvalidated.count, 0, "extinction ownership constraints are fully validated after orphan cleanup");
    const [githubAdminConstraint] = await isolated.query(`
      SELECT convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'CHK_users_admin_not_github'
    `);
    assert.equal(githubAdminConstraint?.convalidated, true, "GitHub/admin authentication separation is enforced on a clean schema");
    assert.match(githubAdminConstraint.definition, /github_id.*role.*admin/i);
  } finally {
    if (isolated?.isInitialized) await isolated.destroy();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.destroy();
  }
}

main().then(() => console.log("Clean PostgreSQL extinction schema passed: all migrations apply and all project/generation/AI ownership edges cascade."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
