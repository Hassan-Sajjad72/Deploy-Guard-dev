// ═══════════════════════════════════════════════════
// Initial Migration — Foundation Schema
// ═══════════════════════════════════════════════════
// Creates: users, projects, deployments, audit_logs,
//          environment_variables with all indexes.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000001 implements MigrationInterface {
  name = 'InitialSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enable UUID extension ───────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── Create enum types ───────────────────────────
    await queryRunner.query(`
      CREATE TYPE "user_role_enum" AS ENUM ('admin', 'developer', 'readonly')
    `);
    await queryRunner.query(`
      CREATE TYPE "subscription_tier_enum" AS ENUM ('free', 'pro')
    `);
    await queryRunner.query(`
      CREATE TYPE "project_status_enum" AS ENUM ('active', 'archived', 'deleted')
    `);
    await queryRunner.query(`
      CREATE TYPE "deployment_status_enum" AS ENUM (
        'pending', 'stack_detection', 'building', 'scanning',
        'scan_passed', 'scan_failed', 'cost_estimating',
        'awaiting_approval', 'provisioning', 'deploying',
        'deployed', 'failed', 'rolling_back', 'rolled_back',
        'cancelled', 'destroying', 'destroyed'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "environment_enum" AS ENUM ('development', 'staging', 'production')
    `);
    await queryRunner.query(`
      CREATE TYPE "audit_action_enum" AS ENUM (
        'user.login', 'user.logout',
        'project.created', 'project.updated', 'project.deleted', 'project.archived',
        'deployment.triggered', 'deployment.approved', 'deployment.cancelled',
        'deployment.completed', 'deployment.failed', 'deployment.rollback',
        'infra.provisioned', 'infra.destroyed',
        'scan.completed', 'scan.blocked',
        'subscription.changed'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "resource_type_enum" AS ENUM (
        'user', 'project', 'deployment', 'environment_variable', 'subscription'
      )
    `);

    // ── Users table ─────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"            UUID DEFAULT uuid_generate_v4() NOT NULL,
        "githubId"      VARCHAR(64) NOT NULL,
        "email"         VARCHAR(255) NOT NULL,
        "username"      VARCHAR(100) NOT NULL,
        "displayName"   VARCHAR(255) NOT NULL,
        "avatarUrl"     VARCHAR(500),
        "role"          "user_role_enum" DEFAULT 'developer' NOT NULL,
        "accessToken"   TEXT NOT NULL,
        "refreshToken"  TEXT,
        "tier"          "subscription_tier_enum" DEFAULT 'free' NOT NULL,
        "isActive"      BOOLEAN DEFAULT true NOT NULL,
        "lastLoginAt"   TIMESTAMPTZ,
        "createdAt"     TIMESTAMPTZ DEFAULT now() NOT NULL,
        "updatedAt"     TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_githubId" UNIQUE ("githubId"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_USER_GITHUB_ID" ON "users" ("githubId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_USER_EMAIL" ON "users" ("email")`);

    // ── Projects table ──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "projects" (
        "id"                UUID DEFAULT uuid_generate_v4() NOT NULL,
        "name"              VARCHAR(255) NOT NULL,
        "description"       TEXT,
        "githubRepoUrl"     VARCHAR(500) NOT NULL,
        "githubRepoId"      VARCHAR(64) NOT NULL,
        "defaultBranch"     VARCHAR(255) DEFAULT 'main' NOT NULL,
        "selectedBranch"    VARCHAR(255) DEFAULT 'main' NOT NULL,
        "detectedStack"     JSONB,
        "deploymentProfile" JSONB,
        "status"            "project_status_enum" DEFAULT 'active' NOT NULL,
        "ownerId"           UUID NOT NULL,
        "createdAt"         TIMESTAMPTZ DEFAULT now() NOT NULL,
        "updatedAt"         TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_projects" PRIMARY KEY ("id"),
        CONSTRAINT "FK_projects_owner" FOREIGN KEY ("ownerId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_PROJECT_GITHUB_REPO_ID" ON "projects" ("githubRepoId")`);
    await queryRunner.query(`CREATE INDEX "IDX_PROJECT_STATUS" ON "projects" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_PROJECT_OWNER" ON "projects" ("ownerId")`);

    // ── Deployments table ───────────────────────────
    await queryRunner.query(`
      CREATE TABLE "deployments" (
        "id"                    UUID DEFAULT uuid_generate_v4() NOT NULL,
        "projectId"             UUID NOT NULL,
        "triggeredById"         UUID,
        "branch"                VARCHAR(255) NOT NULL,
        "commitSha"             VARCHAR(40) NOT NULL,
        "status"                "deployment_status_enum" DEFAULT 'pending' NOT NULL,
        "dockerTemplate"        VARCHAR(100),
        "dockerfileContent"     TEXT,
        "trivyReport"           JSONB,
        "vulnerabilitySummary"  JSONB,
        "costEstimate"          JSONB,
        "terraformPlan"         TEXT,
        "ecsTaskArn"            VARCHAR(500),
        "ecsServiceArn"         VARCHAR(500),
        "albDnsName"            VARCHAR(500),
        "healthCheckUrl"        VARCHAR(500),
        "buildDurationMs"       INTEGER,
        "scanDurationMs"        INTEGER,
        "provisionDurationMs"   INTEGER,
        "deployDurationMs"      INTEGER,
        "failureReason"         TEXT,
        "rollbackFromId"        UUID,
        "metadata"              JSONB,
        "startedAt"             TIMESTAMPTZ,
        "completedAt"           TIMESTAMPTZ,
        "createdAt"             TIMESTAMPTZ DEFAULT now() NOT NULL,
        "updatedAt"             TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_deployments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_deployments_project" FOREIGN KEY ("projectId")
          REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_deployments_user" FOREIGN KEY ("triggeredById")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_DEPLOYMENT_PROJECT" ON "deployments" ("projectId")`);
    await queryRunner.query(`CREATE INDEX "IDX_DEPLOYMENT_STATUS" ON "deployments" ("status")`);

    // ── Audit Logs table ────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"            UUID DEFAULT uuid_generate_v4() NOT NULL,
        "userId"        UUID,
        "action"        "audit_action_enum" NOT NULL,
        "resourceType"  "resource_type_enum" NOT NULL,
        "resourceId"    VARCHAR(255),
        "details"       JSONB,
        "ipAddress"     VARCHAR(45),
        "userAgent"     TEXT,
        "createdAt"     TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_logs_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_AUDIT_USER" ON "audit_logs" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_AUDIT_ACTION" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX "IDX_AUDIT_RESOURCE" ON "audit_logs" ("resourceId")`);
    await queryRunner.query(`CREATE INDEX "IDX_AUDIT_CREATED" ON "audit_logs" ("createdAt")`);

    // ── Environment Variables table ─────────────────
    await queryRunner.query(`
      CREATE TABLE "environment_variables" (
        "id"              UUID DEFAULT uuid_generate_v4() NOT NULL,
        "projectId"       UUID NOT NULL,
        "key"             VARCHAR(255) NOT NULL,
        "encryptedValue"  TEXT NOT NULL,
        "isSecret"        BOOLEAN DEFAULT true NOT NULL,
        "environment"     "environment_enum" DEFAULT 'production' NOT NULL,
        "createdAt"       TIMESTAMPTZ DEFAULT now() NOT NULL,
        "updatedAt"       TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_environment_variables" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ENV_VAR_PROJECT_KEY_ENV" UNIQUE ("projectId", "key", "environment"),
        CONSTRAINT "FK_env_vars_project" FOREIGN KEY ("projectId")
          REFERENCES "projects"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_ENV_VAR_PROJECT" ON "environment_variables" ("projectId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order
    await queryRunner.query(`DROP TABLE IF EXISTS "environment_variables" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "deployments" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "projects" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS "resource_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "audit_action_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "environment_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "deployment_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "project_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_tier_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "user_role_enum"`);

    await queryRunner.query(`DROP EXTENSION IF EXISTS "uuid-ossp"`);
  }
}
