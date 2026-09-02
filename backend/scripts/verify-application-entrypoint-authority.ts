import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireApplicationEntrypointServiceId, resolveApplicationEntrypointServiceId, resolveProjectApplicationUrl } from "../src/projects/application-entrypoint";

const repository = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(repository, path), "utf8");
const backendLow = { serviceId: "00000000-0000-4000-8000-000000000001", serviceName: "backend", serviceDirectory: "backend", publicUrl: "https://backend.example.test" };
const frontendHigh = { serviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", serviceName: "frontend", serviceDirectory: "frontend", publicUrl: "https://frontend.example.test" };

assert.equal(resolveProjectApplicationUrl(frontendHigh.serviceId, [backendLow, frontendHigh]), frontendHigh.publicUrl);
const backendHigh = { ...backendLow, serviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
const frontendLow = { ...frontendHigh, serviceId: "00000000-0000-4000-8000-000000000001" };
assert.equal(resolveProjectApplicationUrl(frontendLow.serviceId, [backendHigh, frontendLow]), frontendLow.publicUrl);

assert.equal(resolveApplicationEntrypointServiceId(null, [frontendHigh]), frontendHigh.serviceId);
assert.equal(resolveProjectApplicationUrl(null, [frontendHigh]), frontendHigh.publicUrl);
assert.throws(() => requireApplicationEntrypointServiceId(null, [backendLow, frontendHigh]), /Select an application service/);

const renamed = { ...frontendHigh, serviceName: "customer-ui" };
assert.equal(resolveApplicationEntrypointServiceId(frontendHigh.serviceId, [renamed, backendLow]), frontendHigh.serviceId);
assert.equal(resolveApplicationEntrypointServiceId(frontendHigh.serviceId, [backendLow, renamed]), frontendHigh.serviceId);
assert.equal(resolveProjectApplicationUrl(frontendHigh.serviceId, [frontendHigh, backendLow]), frontendHigh.publicUrl);
assert.equal(resolveProjectApplicationUrl(frontendHigh.serviceId, [backendLow]), null, "an independently promoted service does not replace a failed configured application entrypoint");
assert.equal(resolveProjectApplicationUrl(null, [backendLow, frontendHigh], "https://historical.example.test"), "https://historical.example.test");
assert.equal(resolveProjectApplicationUrl("11111111-1111-4111-8111-111111111111", [backendLow, frontendHigh], "https://historical.example.test"), null);
assert.throws(() => requireApplicationEntrypointServiceId("11111111-1111-4111-8111-111111111111", [backendLow, frontendHigh]), /does not belong/);

const deployment = read("backend/src/projects/railpack-deployment.service.ts");
assert.doesNotMatch(deployment, /const canonicalEndpoint|canonicalEndpoint\.publicUrl/);
assert.doesNotMatch(deployment, /reduce\(\(selected, service\).*localeCompare\(String\(selected\.serviceId\)\)/);
assert.match(deployment, /const admittedApplicationEntrypoint = current\.metadata\?\.applicationEntryPointServiceId/);
assert.match(deployment, /const applicationEntryPointServiceId = typeof admittedApplicationEntrypoint === "string" \? admittedApplicationEntrypoint : endpointProject\.applicationEntryPointServiceId/);
assert.match(deployment, /const applicationEndpoint = reconciledServices\.find/);
assert.match(deployment, /const deployedUrl = applicationEndpoint &&[\s\S]*?\? applicationEndpoint\.publicUrl : null/);
assert.match(deployment, /metadata: \{ deployedUrl, publicUrls: Object\.fromEntries\(reconciledServices\.map/);

const currentState = read("backend/src/projects/current-state/project-current-state.service.ts");
assert.match(currentState, /resolveProjectApplicationUrl/);
assert.doesNotMatch(currentState, /const canonicalService = services\.reduce/);
assert.match(currentState, /applicationEntryPointServiceId/);

const projects = read("backend/src/projects/projects.service.ts");
assert.match(projects, /Select another application service before removing the current application entrypoint/);
assert.match(projects, /acquireProjectConfigurationAdvisoryLock/);

const migration = read("backend/src/migrations/1787356818000-ProjectApplicationEntrypoint.ts");
assert.match(migration, /HAVING COUNT\(\*\) = 1/);
assert.match(migration, /FOREIGN KEY \("application_entrypoint_service_id", "id"\)/);
assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);

for (const path of ["backend/src/projects/railpack-workflow-contract.ts", ".github/workflows/deployguard-reusable.yml", "infrastructure/railpack-runtime/main.tf", "infrastructure/railpack-runtime/variables.tf", "infrastructure/railpack-runtime/outputs.tf"]) {
  assert.doesNotMatch(read(path), /applicationEntryPointServiceId|application_entrypoint_service_id/);
}

console.log("APPLICATION_ENTRYPOINT_AUTHORITY=PASS");
console.log("UUID_ORDER_INDEPENDENT=PASS");
console.log("SINGLE_SERVICE_AUTO=PASS");
console.log("MULTI_SERVICE_EXPLICIT=PASS");
console.log("IDENTITY_RENAME_REORDER=PASS");
console.log("LIVE_AND_ROLLBACK_URL_PROJECTION=PASS");
console.log("LEGACY_READ_SAFETY=PASS");
console.log("RUNTIME_CONTRACT_UNCHANGED=PASS");
