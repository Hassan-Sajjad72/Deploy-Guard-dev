import "reflect-metadata";
import { strict as assert } from "node:assert";
import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource, DataSourceOptions } from "typeorm";
import { ECSClient } from "@aws-sdk/client-ecs";
import { STSClient } from "@aws-sdk/client-sts";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { WorkspacesModule } from "../src/workspaces/workspaces.module";
import { WorkspacesService } from "../src/workspaces/workspaces.service";
import { BillingModule } from "../src/billing/billing.module";
import { BillingService } from "../src/billing/billing.service";
import { EntitlementService } from "../src/billing/entitlement.service";
import { OrganizationLimitsModule } from "../src/billing/organization-limits.module";
import { OrganizationLimitsService } from "../src/billing/organization-limits.service";
import { AdminAuthorizationModule } from "../src/admin/admin-authorization.module";
import { AdminAuthorizationService } from "../src/admin/admin-authorization.service";
import { AdminModule } from "../src/admin/admin.module";
import { AdminController } from "../src/admin/admin.controller";
import { AiTroubleshootingModule } from "../src/ai-troubleshooting/ai-troubleshooting.module";
import { AiUsageService } from "../src/ai-troubleshooting/ai-usage.service";
import { PlanningModule } from "../src/planning/planning.module";
import { PlanningService } from "../src/planning/planning.service";
import { CustomerAwsSessionService } from "../src/planning/customer-aws-session.service";
import { RecoveryModule } from "../src/recovery/recovery.module";
import { RecoveryService } from "../src/recovery/recovery.service";
import { RepairService } from "../src/recovery/repair.service";
import { IntelligenceModule } from "../src/operational-intelligence/intelligence.module";
import { IntelligenceService } from "../src/operational-intelligence/intelligence.service";
import { UsersService } from "../src/users/users.service";

/** Only module construction, schema upgrade and local read paths; never dispatches a provider operation. */
async function verify() {
  const container = await new PostgreSqlContainer("deployguard-local/postgres:local").start();
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let schema: DataSource | undefined;
  const originalFetch = globalThis.fetch;
  const sdkClientPrototype = Object.getPrototypeOf(ECSClient.prototype);
  assert.equal(Object.getPrototypeOf(STSClient.prototype), sdkClientPrototype, "The customer ECS and STS clients must share the guarded SDK transport.");
  const originalSdkSend = sdkClientPrototype.send;
  let externalRequests = 0;
  globalThis.fetch = (async () => { externalRequests++; throw new Error("External HTTP is disabled in the focused module integration fixture."); }) as any;
  sdkClientPrototype.send = () => { externalRequests++; throw new Error("AWS SDK calls are disabled in the focused module integration fixture."); };
  try {
    const config = new ConfigService({ NODE_ENV: "test", AUTH_SESSION_SECRET: "focused-module-context-fixture-secret-32-characters",
      BILLING_PROVIDER_ENABLED: "false", NOTIFICATION_DELIVERY_ENABLED: "false", AWS_REGION: "us-east-1" });
    Reflect.set(config, "skipProcessEnv", true);
    const imports: any[] = Reflect.getMetadata("imports", AppModule);
    for (const module of [WorkspacesModule, BillingModule, PlanningModule, RecoveryModule, IntelligenceModule]) assert.ok(imports.includes(module), `${module.name} must be included in the actual API module`);
    const typeOrm = imports.find((entry) => entry?.module === TypeOrmModule);
    const factory = typeOrm.imports[0].providers.find((entry: any) => entry.provide === "TypeOrmModuleOptions").useFactory;
    const appOptions = factory(config);
    const options: DataSourceOptions = { ...AppDataSource.options, host: container.getHost(), port: container.getPort(),
      username: container.getUsername(), password: container.getPassword(), database: container.getDatabase(), ssl: false, logging: false, synchronize: false } as DataSourceOptions;
    schema = new DataSource(options); await schema.initialize();
    const migrations = [...schema.migrations];
    const current = migrations.filter((migration) => Number(migration.name?.slice(-13) || migration.constructor.name.slice(-13)) < 1791676800000);
    schema.migrations.splice(0, schema.migrations.length, ...current); await schema.runMigrations({ transaction: "each" });
    const [existingUser] = await schema.query(`INSERT INTO users(name,email,github_id,role) VALUES('Existing workspace owner','fixture@example.invalid','focused-module-owner','developer') RETURNING id`);
    const [existingProject] = await schema.query(`INSERT INTO projects(owner_user_id,name,repository_url,repository_full_name) VALUES($1,'Existing project','https://github.com/fixture/app','fixture/app') RETURNING id`, [existingUser.id]);
    schema.migrations.splice(0, schema.migrations.length, ...migrations);
    const upgraded = await schema.runMigrations({ transaction: "each" });
    assert.ok(upgraded.length >= 13, "The new ownership, execution, evidence and quota migrations must run after the existing schema.");
    const names = upgraded.map((migration) => migration.name);
    for (const prefix of ["SessionRevocation", "OrganizationOwnership", "DeploymentPlans", "OrganizationAiBudget", "OrganizationBilling", "OperationalIntelligence", "GovernedRecovery", "OrganizationEntitlementVersions", "RetainedAuditEvidence"]) {
      assert.ok(names.some((name) => name.startsWith(prefix)), `${prefix} must be registered in the migration glob`);
    }
    assert.deepEqual(await schema.runMigrations({ transaction: "each" }), [], "Migration history must prevent a second schema upgrade.");
    const [owned] = await schema.query(`SELECT project.organization_id, organization.personal_owner_user_id FROM projects project JOIN organizations organization ON organization.id=project.organization_id WHERE project.id=$1`, [existingProject.id]);
    assert.equal(owned.personal_owner_user_id, existingUser.id, "An existing project must receive its owner's migrated personal workspace.");
    const newTables = new Set(["organizations", "organization_memberships", "aws_account_bindings", "deployment_plans", "deployment_plan_decisions", "governed_recovery_requests", "governed_recovery_decisions", "supervised_repair_proposals", "operational_intelligence_records", "organization_entitlement_versions", "auth_session_revocations", "billing_invoices", "billing_payments"]);
    const appEntities = new Set(appOptions.entities);
    for (const metadata of schema.entityMetadatas.filter((entry) => newTables.has(entry.tableName))) {
      assert.ok(appEntities.has(metadata.target), `${metadata.name} must be registered in the actual application data source`);
      const columns = new Set((await schema.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [metadata.tableName])).map((entry: any) => entry.column_name));
      for (const column of metadata.columns) assert.ok(columns.has(column.databaseName), `${metadata.tableName}.${column.databaseName} must exist after upgrade`);
    }
    for (const table of newTables) assert.ok(schema.entityMetadatas.some((metadata) => metadata.tableName === table), `${table} must have registered entity metadata`);
    @Global()
    @Module({ providers: [{ provide: ConfigService, useValue: config }], exports: [ConfigService] })
    class FixtureConfigurationModule {}
    @Module({ imports: [FixtureConfigurationModule, TypeOrmModule.forRoot({ ...options, entities: appOptions.entities, migrations: [], retryAttempts: 0 }),
      WorkspacesModule, BillingModule, OrganizationLimitsModule, AdminAuthorizationModule, AdminModule, AiTroubleshootingModule, PlanningModule, RecoveryModule, IntelligenceModule] })
    class FocusedModuleContext {}
    app = await NestFactory.createApplicationContext(FocusedModuleContext, { logger: false, abortOnError: false });
    for (const provider of [WorkspacesService, BillingService, OrganizationLimitsService, AdminAuthorizationService, AiUsageService, PlanningService, CustomerAwsSessionService, RecoveryService, RepairService, IntelligenceService]) assert.ok(app.get(provider), `${provider.name} must resolve through actual Nest dependency injection`);
    const limits = app.get(OrganizationLimitsService);
    assert.equal((app.get(WorkspacesService) as any).limits, limits, "Workspace creation must receive the actual quota service.");
    assert.equal((app.get(AiUsageService) as any).organizationLimits, limits, "AI reservations must receive the same versioned quota service.");
    assert.equal((app.get(EntitlementService) as any).organizationLimits, limits, "Project admission must receive the same versioned quota service.");
    const freshOwner = await app.get(UsersService).findById(existingUser.id);
    assert.ok(freshOwner);
    const evidence = await limits.view(freshOwner!, owned.organization_id);
    assert.equal(evidence.usage.projects, 1);
    assert.equal(evidence.usage.members, 1);
    assert.equal(evidence.limits.projects, null, "The upgrade must not invent a reviewed project override.");
    const intelligence = await app.get(IntelligenceService).list(freshOwner!, existingProject.id);
    assert.equal(intelligence.records.length, 0); assert.equal(intelligence.canManage, true);
    const recovery = await app.get(RecoveryService).list(freshOwner!, existingProject.id);
    assert.equal(recovery.requests.length, 0);
    const repairs = await app.get(RepairService).list(freshOwner!, existingProject.id);
    assert.equal(repairs.proposals.length, 0);
    await schema.query(`INSERT INTO projects(owner_user_id,organization_id,name,repository_url,repository_full_name,archived_at) VALUES($1,$2,'Retained archived project','https://github.com/fixture/archive','fixture/archive',now())`,[existingUser.id,owned.organization_id]);
    const [operator] = await schema.query(`INSERT INTO users(name,email,role,internal_admin_role) VALUES('Scoped operator','operator@example.invalid','admin','platform_ops') RETURNING id`);
    const admin = app.get(AdminController);
    const adminOrganizations = await admin.listOrganizations({user:{id:operator.id,role:"admin",githubId:null,internalAdminRole:"platform_ops"}} as any);
    assert.equal(adminOrganizations.organizations.find((organization:any)=>organization.id===owned.organization_id).projects,1,"Operator reporting must exclude projects archived by timestamp while preserving their evidence.");
    await assert.rejects(admin.listOrganizations({user:{id:operator.id,role:"admin",githubId:null,internalAdminRole:"billing"}} as any),/scope/i);
    await assert.rejects(app.get(RecoveryService).incident(existingProject.id, "11111111-1111-4111-8111-111111111111"), /incident/i);
    assert.equal(externalRequests, 0, "Module initialization and these local reads must not make provider HTTP calls.");
    console.log("Focused new-module Nest DI, existing-schema migration order, entity compatibility and local evidence reads passed.");
  } finally {
    if (app) await app.close();
    if (schema?.isInitialized) await schema.destroy();
    await container.stop(); globalThis.fetch = originalFetch; sdkClientPrototype.send = originalSdkSend;
  }
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
