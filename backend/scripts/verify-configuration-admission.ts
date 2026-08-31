import "reflect-metadata";
import { strict as assert } from "node:assert";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GithubAppService, canonicalDeployguardReusableWorkflow } from "../src/projects/github-app.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

void (async () => {
const emptyConfig = new ConfigService({});
const github = new GithubAppService({
  find: async () => [],
  findOne: async () => null,
  create: (value: unknown) => value,
  save: async (value: unknown) => value,
} as any, emptyConfig);
assert.equal(github.configured(), false);
assert.equal(github.statusUrl(), null);
assert.throws(() => canonicalDeployguardReusableWorkflow(emptyConfig), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503 && /release revision is not configured/.test(error.message));
await assert.rejects(() => github.connectInstallation({} as any, "not-numeric"), (error: any) => error instanceof BadRequestException && /Invalid GitHub App installation id/.test(error.message));
await assert.rejects(() => github.tokenForRepository(1, "inaccessible/repository"), (error: any) => error instanceof BadRequestException && /Install the DeployGuard GitHub App/.test(error.message));

const railpack = Object.create(RailpackDeploymentService.prototype) as any;
railpack.config = emptyConfig;
for (const key of ["DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "DEPLOYGUARD_VPC_ID", "DEPLOYGUARD_PUBLIC_SUBNET_IDS", "DEPLOYGUARD_TERRAFORM_STATE_BUCKET"]) {
  assert.throws(() => railpack.required(key), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503 && error.message === `Platform configuration is missing: ${key}.`);
}
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /DEPLOYGUARD_REUSABLE_WORKFLOW/.test(error.message));
railpack.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: "owner/repository/.github/workflows/deployguard-reusable.yml@main" });
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /exact control-plane SHA/.test(error.message));

console.log("CONFIGURATION_ADMISSION_MATRIX=PASS GITHUB_APP=1 REPOSITORY=1 AWS_REQUIRED_INPUTS=4 CONTROL_PLANE_PIN=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
