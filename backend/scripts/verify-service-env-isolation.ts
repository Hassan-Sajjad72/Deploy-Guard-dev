import "reflect-metadata";
import { strict as assert } from "node:assert";
import { RuntimeSecretMaterializer } from "../src/projects/github-actions-runtime-secret.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const webId = "22222222-2222-4222-8222-222222222222";
const apiId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const service = Object.create(RailpackDeploymentService.prototype) as any;
service.deployableServices = { find: async () => [
  { id: webId, projectId, name: "Web", serviceDirectory: "web", position: 0 },
  { id: apiId, projectId, name: "API", serviceDirectory: "api", position: 1 },
] };
const variables = [
  { serviceId: webId, key: "PUBLIC_NAME", value: "web-value", isSecret: false, scope: "runtime" },
  { serviceId: webId, key: "WEB_BUILD", value: "web-build", isSecret: false, scope: "build" },
  { serviceId: webId, key: "WEB_BOTH", value: "web-both", isSecret: false, scope: "both" },
  { serviceId: webId, key: "WEB_BUILD_SECRET", value: "web-build-secret", isSecret: true, scope: "build" },
  { serviceId: webId, key: "WEB_BOTH_SECRET", value: "web-both-secret", isSecret: true, scope: "both" },
  { serviceId: webId, key: "WEB_RUNTIME_SECRET", value: "web-runtime-secret", isSecret: true, scope: "runtime" },
  { serviceId: webId, key: "DATABASE_URL", value: "legacy-user-database-url", isSecret: true, scope: "both" },
  { serviceId: apiId, key: "API_BUILD", value: "api-build", isSecret: false, scope: "build" },
  { serviceId: apiId, key: "API_TOKEN", value: "api-secret", isSecret: true, scope: "runtime" },
  { serviceId: apiId, key: "API_BUILD_TOKEN", value: "api-build-secret", isSecret: true, scope: "build" },
  { serviceId: apiId, key: "MONGODB_URI", value: "legacy-user-mongodb-uri", isSecret: true, scope: "runtime" },
  { serviceId: apiId, key: "PORT", value: "9999", isSecret: false, scope: "both" },
];
service.variables = { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getMany: async () => variables }) };
let managedTier: any = { provider: "managed", engine: "postgres", attachedServiceId: apiId };
service.databaseTiers = { findOne: async () => managedTier };
service.crypto = { decrypt: (value: string) => value };
const materializations: any[] = [];
service.runtimeSecrets = { materialize: async (input: any) => { materializations.push(input); const versionToken = "f".repeat(64); return Object.keys(input.secretValues).length ? { versionToken, secretNames: Object.keys(input.secretValues), valueFromByName: Object.fromEntries(Object.keys(input.secretValues).map((key) => [key, `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.serviceId}:${key}::${versionToken}`])) } : null; } };
service.runtimeConfigRevisions = { create: (value: any) => value, save: async (value: any) => ({ ...value, id: value.serviceId === webId ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666" }) };
service.dataSource = { getRepository: () => ({ find: async () => [] }) };

void (async () => {
  const runtime = await service.runtimeConfiguration({ id: projectId }, "cert-20260831", operationId, "a".repeat(40), "deploy", null);
  assert.equal(runtime.services.length, 2);
  const web = runtime.services.find((item: any) => item.serviceId === webId);
  const api = runtime.services.find((item: any) => item.serviceId === apiId);
  assert.deepEqual(web.buildEnvironment, { WEB_BUILD: "web-build", WEB_BOTH: "web-both" });
  assert.deepEqual(web.environment, { PORT: "8080", HOST: "0.0.0.0", PUBLIC_NAME: "web-value", WEB_BOTH: "web-both" });
  assert.deepEqual(Object.keys(web.buildSecretReferences), ["WEB_BOTH_SECRET", "WEB_BUILD_SECRET"]);
  assert.deepEqual(Object.keys(web.secretReferences), ["WEB_BOTH_SECRET", "WEB_RUNTIME_SECRET"]);
  assert.equal(web.buildSecretReferences.WEB_RUNTIME_SECRET, undefined, "runtime-only secrets never reach the build");
  assert.equal(web.secretReferences.WEB_BUILD_SECRET, undefined, "build-only secrets never reach ECS runtime");
  assert.equal(web.environment.DATABASE_URL, undefined);
  assert.equal(web.databaseAttached, false);
  assert.equal(web.managedDatabase.aliases.length, 0);
  assert.equal(api.environment.PORT, "8080", "platform PORT overrides user input");
  assert.equal(api.environment.HOST, "0.0.0.0");
  assert.equal(api.environment.PUBLIC_NAME, undefined);
  assert.deepEqual(api.buildEnvironment, { API_BUILD: "api-build" });
  assert.equal(api.buildEnvironment.WEB_BUILD, undefined, "build ENV remains service-scoped");
  assert.match(api.buildSecretReferences.API_BUILD_TOKEN, new RegExp(apiId));
  assert.match(api.secretReferences.API_TOKEN, new RegExp(apiId));
  assert.equal(api.secretReferences.MONGODB_URI, undefined, "legacy user database aliases cannot enter runtime secrets");
  assert.equal(api.databaseAttached, true);
  assert.ok(api.managedDatabase.aliases.includes("DATABASE_URL"));
  assert.ok(api.managedDatabase.aliases.includes("POSTGRES_PASSWORD"));
  assert.deepEqual(materializations.map((item) => [item.serviceId, Object.keys(item.secretValues)]), [[webId, ["WEB_BUILD_SECRET", "WEB_BOTH_SECRET", "WEB_RUNTIME_SECRET"]], [apiId, ["API_TOKEN", "API_BUILD_TOKEN"]]]);
  assert.deepEqual(materializations.map((item) => item.environment), ["cert-20260831", "cert-20260831"], "named project environments survive runtime configuration unchanged");

  managedTier = null;
  materializations.length = 0;
  const unmanagedRuntime = await service.runtimeConfiguration({ id: projectId }, "cert-20260831", "77777777-7777-4777-8777-777777777777", "b".repeat(40), "deploy", null);
  for (const item of unmanagedRuntime.services) {
    assert.equal(item.databaseAttached, false);
    assert.deepEqual(item.managedDatabase, { engine: null, aliases: [] });
    assert.equal(item.environment.DATABASE_URL, undefined);
    assert.equal(item.secretReferences.MONGODB_URI, undefined);
  }
  assert.deepEqual(materializations.map((item) => [item.serviceId, Object.keys(item.secretValues)]), [[webId, ["WEB_BUILD_SECRET", "WEB_BOTH_SECRET", "WEB_RUNTIME_SECRET"]], [apiId, ["API_TOKEN", "API_BUILD_TOKEN"]]], "scope-aware secrets remain isolated while legacy database ENV is discarded");

  managedTier = { provider: "managed", engine: "redis", attachedServiceId: apiId };
  materializations.length = 0;
  await assert.rejects(
    () => service.runtimeConfiguration({ id: projectId }, "cert-20260831", "88888888-8888-4888-8888-888888888888", "c".repeat(40), "deploy", null),
    /managed database engine is unsupported/,
  );
  assert.equal(materializations.length, 0, "unsupported managed capabilities fail before secret or infrastructure materialization");

  let providerCalls = 0;
  const materializer = new RuntimeSecretMaterializer({
    describe: async () => { providerCalls += 1; return null; },
    create: async () => { providerCalls += 1; return "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/test"; },
    restore: async () => undefined,
    put: async () => undefined,
    activateVersion: async () => undefined,
  });
  const namedEnvironmentSecret = await materializer.materialize({
    projectId,
    serviceId: apiId,
    generationId: operationId,
    environment: "cert-20260831",
    configurationFingerprint: "a".repeat(64),
    secretValues: { API_TOKEN: "bounded-test-value" },
  });
  assert.equal(providerCalls, 2, "a valid named environment reaches secret-provider materialization");
  assert.match(namedEnvironmentSecret?.valueFromByName.API_TOKEN || "", /:API_TOKEN::[0-9a-f]{64}$/);
  console.log("SERVICE_ENV_ISOLATION=PASS BUILD_RUNTIME_BOTH=1 SERVICE_SECRET_LEAKS=0 DATABASE_ATTACHMENT_EXACT=1 UNSUPPORTED_DATABASE_PREMUTATION=1 PLATFORM_PORT_AUTHORITY=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
