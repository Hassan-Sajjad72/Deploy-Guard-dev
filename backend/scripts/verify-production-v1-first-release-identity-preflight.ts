import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { ProductionV1FirstReleaseIdentityPreflightService } from "../src/orchestration-contracts/release-lane/production-v1-first-release-identity-preflight.service";

const composition = { getInactiveComposition: () => null } as any;
const noDatabase = { getRepository: () => { throw new Error("DATABASE_MUST_NOT_BE_READ_WHEN_DISABLED"); } } as any;

void (async () => {
  const disabled = new ProductionV1FirstReleaseIdentityPreflightService(
    new ConfigService({}), noDatabase, composition,
  );
  assert.deepEqual(await disabled.run(), {
    state: "disabled", safeCodes: ["FIRST_RELEASE_IDENTITY_PREFLIGHT_DISABLED"],
    manifestVerified: false, foundationVerified: false, releaseEvidenceAbsent: false,
    serviceAbsent: false, taskDefinitionAbsent: false,
  });
  const source = readFileSync(
    "src/orchestration-contracts/release-lane/production-v1-first-release-identity-preflight.service.ts",
    "utf8",
  );
  for (const forbidden of ["RegisterTaskDefinitionCommand", "UpdateServiceCommand", "CreateServiceCommand", "DeleteServiceCommand", "terraform apply", "terraform destroy"]) {
    assert.equal(source.includes(forbidden), false, `read-only preflight contains ${forbidden}`);
  }
  assert.match(source, /DescribeRepositoriesCommand/);
  assert.match(source, /DescribeClustersCommand/);
  assert.match(source, /DescribeServicesCommand/);
  assert.match(source, /ListTaskDefinitionsCommand/);
  console.log("Production v1 first-release identity preflight verification passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
