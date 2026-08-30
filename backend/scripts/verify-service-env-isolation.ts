import "reflect-metadata";
import { strict as assert } from "node:assert";
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
  { serviceId: webId, key: "PUBLIC_NAME", value: "web-value", isSecret: false },
  { serviceId: apiId, key: "API_TOKEN", value: "api-secret", isSecret: true },
  { serviceId: apiId, key: "PORT", value: "9999", isSecret: false },
];
service.variables = { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getMany: async () => variables }) };
service.databaseTiers = { findOne: async () => ({ provider: "managed", engine: "postgres", attachedServiceId: apiId }) };
service.crypto = { decrypt: (value: string) => value };
const materializations: any[] = [];
service.runtimeSecrets = { materialize: async (input: any) => { materializations.push(input); return { valueFromByName: Object.fromEntries(Object.keys(input.secretValues).map((key) => [key, `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.serviceId}:${key}::`])) }; } };
service.dataSource = { getRepository: () => ({ find: async () => [] }) };

void (async () => {
  const runtime = await service.runtimeConfiguration({ id: projectId }, "dev", operationId, "a".repeat(40), "deploy", null);
  assert.equal(runtime.services.length, 2);
  const web = runtime.services.find((item: any) => item.serviceId === webId);
  const api = runtime.services.find((item: any) => item.serviceId === apiId);
  assert.deepEqual(web.environment, { PORT: "8080", HOST: "0.0.0.0", PUBLIC_NAME: "web-value" });
  assert.deepEqual(web.secretReferences, {});
  assert.equal(web.databaseAttached, false);
  assert.equal(web.managedDatabase.aliases.length, 0);
  assert.equal(api.environment.PORT, "8080", "platform PORT overrides user input");
  assert.equal(api.environment.HOST, "0.0.0.0");
  assert.equal(api.environment.PUBLIC_NAME, undefined);
  assert.match(api.secretReferences.API_TOKEN, new RegExp(apiId));
  assert.equal(api.databaseAttached, true);
  assert.ok(api.managedDatabase.aliases.includes("DATABASE_URL"));
  assert.ok(api.managedDatabase.aliases.includes("POSTGRES_PASSWORD"));
  assert.deepEqual(materializations.map((item) => [item.serviceId, Object.keys(item.secretValues)]), [[webId, []], [apiId, ["API_TOKEN"]]]);
  console.log("SERVICE_ENV_ISOLATION=PASS SERVICE_SECRET_LEAKS=0 DATABASE_ATTACHMENT_EXACT=1 PLATFORM_PORT_AUTHORITY=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
