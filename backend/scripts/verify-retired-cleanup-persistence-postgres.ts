import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import "dotenv/config";

async function verify() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
    assert.ok(user.rows[0]?.id, "A local verification user is required");
    const projectId = randomUUID();
    const profileId = randomUUID();
    const generationId = randomUUID();
    const sourceRunId = randomUUID();

    await client.query(`INSERT INTO projects
      (id, owner_user_id, name, repository_url, repository_provider, repository_full_name, target_branch, environment_name, status, visibility)
      VALUES ($1, $2, 'cleanup-fk-verification', 'https://github.com/example/cleanup-fk-verification.git', 'github', $3, 'main', 'dev', 'configured', 'private')`,
    [projectId, user.rows[0].id, `example/cleanup-fk-${projectId}`]);
    await client.query(`INSERT INTO project_detection_profiles
      (id, project_id, repository_url, repository_full_name, target_branch, ecosystem, confidence, detection_status)
      VALUES ($1, $2, 'https://github.com/example/cleanup-fk-verification.git', $3, 'main', 'javascript', 'high', 'success')`,
    [profileId, projectId, `example/cleanup-fk-${projectId}`]);
    await client.query(`INSERT INTO project_deployment_generations
      (id, project_id, environment_name, ordinal, status, terraform_state_key, resource_manifest, cleanup_metadata, metadata)
      VALUES ($1, $2, 'dev', 1, 'retired', $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [generationId, projectId, `projects/${projectId}/dev/${generationId}/terraform.tfstate`]);
    await client.query(`INSERT INTO project_pipeline_runs
      (id, project_id, generation_id, triggered_by_user_id, detection_profile_id, repository_url, repository_full_name, target_branch, commit_sha, status, current_stage, metadata)
      VALUES ($1, $2, $3, $4, $5, 'https://github.com/example/cleanup-fk-verification.git', $6, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'completed', 'healthy', '{"executionEngine":"github_actions","deploymentAction":"deploy"}'::jsonb)`,
    [sourceRunId, projectId, generationId, user.rows[0].id, profileId, `example/cleanup-fk-${projectId}`]);

    // PostgreSQL clears the persisted source association, while an entity that
    // was loaded before this deletion can still contain profileId in memory.
    await client.query(`DELETE FROM project_detection_profiles WHERE id = $1`, [profileId]);
    const source = await client.query(`SELECT detection_profile_id FROM project_pipeline_runs WHERE id = $1`, [sourceRunId]);
    assert.equal(source.rows[0]?.detection_profile_id, null);

    await client.query("SAVEPOINT stale_association");
    await assert.rejects(
      client.query(`INSERT INTO project_pipeline_runs
        (id, project_id, generation_id, triggered_by_user_id, detection_profile_id, repository_url, repository_full_name, target_branch, commit_sha, status, current_stage, metadata)
        VALUES ($1, $2, $3, $4, $5, 'https://github.com/example/cleanup-fk-verification.git', $6, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'queued', 'retired_generation_cleanup_dispatch', '{"executionEngine":"github_actions","deploymentAction":"cleanup","internalMaintenance":true}'::jsonb)`,
      [randomUUID(), projectId, generationId, user.rows[0].id, profileId, `example/cleanup-fk-${projectId}`]),
      /FK_2f5370c628be2f7be33b1a08021/,
    );
    await client.query("ROLLBACK TO SAVEPOINT stale_association");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.query(`INSERT INTO project_pipeline_runs
        (id, project_id, generation_id, triggered_by_user_id, detection_profile_id, repository_url, repository_full_name, target_branch, commit_sha, status, current_stage, metadata)
        VALUES ($1, $2, $3, $4, NULL, 'https://github.com/example/cleanup-fk-verification.git', $5, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'queued', 'retired_generation_cleanup_dispatch', $6::jsonb)`,
      [randomUUID(), projectId, generationId, user.rows[0].id, `example/cleanup-fk-${projectId}`, JSON.stringify({ executionEngine: "github_actions", deploymentAction: "cleanup", internalMaintenance: true, retryOrdinal: attempt })]);
    }
    const cleanups = await client.query(`SELECT count(*)::int AS count FROM project_pipeline_runs WHERE project_id = $1 AND metadata ->> 'deploymentAction' = 'cleanup'`, [projectId]);
    assert.equal(cleanups.rows[0]?.count, 2, "initial and repeated cleanup persistence must both satisfy the schema");
    await client.query(`UPDATE project_deployment_generations SET status = 'cleaned', cleaned_at = now() WHERE id = $1`, [generationId]);
    await client.query(`UPDATE project_deployment_generations SET status = 'cleaned', cleaned_at = COALESCE(cleaned_at, now()) WHERE id = $1`, [generationId]);
    const generation = await client.query(`SELECT status FROM project_deployment_generations WHERE id = $1`, [generationId]);
    assert.equal(generation.rows[0]?.status, "cleaned");
    console.log("Retired-generation cleanup FK persistence and repeat convergence verification passed.");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

void verify();
