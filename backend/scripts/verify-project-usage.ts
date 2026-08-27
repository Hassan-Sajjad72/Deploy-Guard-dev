import "reflect-metadata";
import * as assert from "node:assert/strict";
import dataSource from "../src/data-source";
import { EntitlementService } from "../src/billing/entitlement.service";
import { ProjectUsageService } from "../src/billing/project-usage.service";
import { ProjectPipelineRun, PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../src/projects/project.entity";
import { User, UserRole } from "../src/users/user.entity";

async function main() {
  const originalEnforcement = process.env.PLAN_USAGE_ENFORCEMENT_ENABLED;
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const users = runner.manager.getRepository(User);
    const projects = runner.manager.getRepository(Project);
    const runs = runner.manager.getRepository(ProjectPipelineRun);
    const user = await users.save(users.create({ name: "Usage Verification", email: `usage-${Date.now()}@example.test`, role: UserRole.DEVELOPER }));
    const usageService = new ProjectUsageService(projects, runs);
    const entitlements = new EntitlementService(dataSource, usageService);
    assert.deepEqual(await usageService.counts(user.id, runner.manager), { totalProjects: 0, activeProjects: 0, activeRuns: 0 });

    const addProject = (index: number) => projects.save(projects.create({ ownerUserId: user.id, name: `Project ${index}`, repositoryUrl: `https://github.com/example/project-${index}`, repositoryProvider: "github", repositoryFullName: `example/project-${index}`, targetBranch: "main", status: ProjectStatus.CREATED, visibility: ProjectVisibility.PRIVATE }));
    const first = await addProject(1); await addProject(2);
    assert.equal((await usageService.counts(user.id, runner.manager)).activeProjects, 2);
    const third = await addProject(3);
    assert.equal((await usageService.counts(user.id, runner.manager)).activeProjects, 3);
    process.env.PLAN_USAGE_ENFORCEMENT_ENABLED = "true";
    await assert.rejects(() => entitlements.assertCanCreateProject(user.id, runner.manager), /currently have 3/);
    process.env.PLAN_USAGE_ENFORCEMENT_ENABLED = "false";
    const testingDecision = await entitlements.assertCanCreateProject(user.id, runner.manager);
    assert.equal(testingDecision.allowed, true);
    assert.equal(testingDecision.enforcement.enabled, false);
    assert.match(testingDecision.reason, /disabled for testing/);
    const fourth = await addProject(4);
    assert.equal((await usageService.counts(user.id, runner.manager)).activeProjects, 4);
    fourth.status = ProjectStatus.ARCHIVED; fourth.archivedAt = new Date(); await projects.save(fourth);
    assert.equal((await usageService.counts(user.id, runner.manager)).activeProjects, 3);
    third.status = ProjectStatus.ARCHIVED; third.archivedAt = new Date(); await projects.save(third);
    assert.equal((await usageService.counts(user.id, runner.manager)).activeProjects, 2);
    assert.equal((await entitlements.assertCanCreateProject(user.id, runner.manager)).activeProjects, 2);

    for (const status of [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING, PipelineRunStatus.COMPLETED, PipelineRunStatus.FAILED, PipelineRunStatus.CANCELLED, PipelineRunStatus.ROLLBACK_SUCCEEDED]) {
      await runs.save(runs.create({ projectId: first.id, triggeredByUserId: user.id, repositoryUrl: first.repositoryUrl, repositoryFullName: first.repositoryFullName, targetBranch: first.targetBranch, status }));
    }
    assert.equal((await usageService.counts(user.id, runner.manager)).activeRuns, 2);
    console.log("Project usage database verification passed: 0/2/3/4, archives, enforcement, and terminal runs.");
  } finally {
    if (originalEnforcement === undefined) delete process.env.PLAN_USAGE_ENFORCEMENT_ENABLED;
    else process.env.PLAN_USAGE_ENFORCEMENT_ENABLED = originalEnforcement;
    await runner.rollbackTransaction();
    await runner.release();
    await dataSource.destroy();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
