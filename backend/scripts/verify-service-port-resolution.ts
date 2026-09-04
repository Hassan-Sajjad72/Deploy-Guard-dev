import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServicePort, resolveServicePorts, SERVICE_PORT_FAILURE, ServicePortResolutionError } from "../src/projects/service-port-resolver";

async function main() {
const root = join(__dirname, "..", "..");
const fixture = await mkdtemp(join(tmpdir(), "deployguard-port-resolution-"));
const serviceId = "11111111-1111-4111-8111-111111111111";
const otherServiceId = "22222222-2222-4222-8222-222222222222";

async function directory(name: string, files: Record<string, string>) {
  const target = join(fixture, name);
  for (const [filename, content] of Object.entries(files)) {
    const path = join(target, filename);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return target;
}

async function failure(name: string, expectedCode: string) {
  try {
    await resolveServicePort(serviceId, join(fixture, name));
    assert.fail(`${name} should fail port resolution`);
  } catch (error) {
    assert.ok(error instanceof ServicePortResolutionError);
    assert.equal(error.code, expectedCode);
    assert.match(error.safeDetail, new RegExp(`serviceId=${serviceId} code=${expectedCode} stage=service_port_resolution`));
  }
}

try {
  const rootBinding = await directory("root-binding", { "server.js": "const app = express(); app.listen(4321);" });
  assert.equal((await resolveServicePort(serviceId, rootBinding)).servicePort, 4321, "root application binding resolves");

  const precedence = await directory("precedence", { "application.properties": "server.port=9100\n", "server.js": "app.listen(3200);", ".env": "PORT=4400\n" });
  assert.deepEqual(await resolveServicePort(serviceId, precedence), { serviceId, servicePort: 9100, evidence: { priority: 1, source: "application.properties:server.port" } });

  const sourceBinding = await directory("source-binding", { "app.py": "app.run(host='0.0.0.0', port=5001)" });
  assert.equal((await resolveServicePort(serviceId, sourceBinding)).servicePort, 5001);

  const indirectSourceBinding = await directory("indirect-source-binding", { "server.js": "const PORT = Number(process.env.PORT) || 4201; app.listen(PORT);" });
  assert.equal((await resolveServicePort(serviceId, indirectSourceBinding)).servicePort, 4201);

  const declaredEntrypoint = await directory("declared-entrypoint", { "package.json": JSON.stringify({ scripts: { start: "node src/custom-runtime.js" } }), "src/custom-runtime.js": "server.listen(4202);", "tests/server.js": "server.listen(9999);" });
  assert.equal((await resolveServicePort(serviceId, declaredEntrypoint)).servicePort, 4202, "the authoritative start target is inspected while test servers are ignored");

  const startCommand = await directory("start-command", { "package.json": JSON.stringify({ scripts: { start: "node server.js --port 3100" } }) });
  assert.equal((await resolveServicePort(serviceId, startCommand)).servicePort, 3100);

  const environment = await directory("environment", { ".env.production": "PORT=4500\n" });
  assert.equal((await resolveServicePort(serviceId, environment)).servicePort, 4500);

  const framework = await directory("framework", { "requirements.txt": "Django==5.2.0\n" });
  assert.equal((await resolveServicePort(serviceId, framework)).servicePort, 8000);

  await directory("unresolved", { "README.md": "No authoritative application port." });
  await failure("unresolved", SERVICE_PORT_FAILURE.unresolved);

  await directory("conflict", { "app.js": "app.listen(3000);", "server.js": "server.listen(4000);" });
  await failure("conflict", SERVICE_PORT_FAILURE.conflict);

  await directory("invalid", { ".env": "PORT=99999\n", "requirements.txt": "Django==5.2.0\n" });
  await failure("invalid", SERVICE_PORT_FAILURE.invalid);

  await directory("apps/frontend", { "package.json": JSON.stringify({ config: { port: 3000 } }) });
  await directory("apps/backend", { "main.py": "app.run(port=8000)" });
  const multi = await resolveServicePorts(fixture, [
    { serviceId, serviceDirectory: "apps/frontend" },
    { serviceId: otherServiceId, serviceDirectory: "apps/backend" },
  ]);
  assert.deepEqual(multi.map((item) => [item.serviceId, item.servicePort]), [[serviceId, 3000], [otherServiceId, 8000]], "each service is resolved only inside its canonical directory");

  const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const terraform = readFileSync(join(root, "infrastructure/railpack-runtime/main.tf"), "utf8");
  const newProject = readFileSync(join(root, "frontend/src/pages/NewProject.jsx"), "utf8");
  const settings = readFileSync(join(root, "frontend/src/pages/ProjectSettings.jsx"), "utf8");
  const dto = readFileSync(join(root, "backend/src/projects/dto/deployable-service.dto.ts"), "utf8");
  const deployment = readFileSync(join(root, "backend/src/projects/railpack-deployment.service.ts"), "utf8");
  const repositorySource = readFileSync(join(root, "backend/src/projects/repository-source.service.ts"), "utf8");

  assert.match(workflow, /--publish "127\.0\.0\.1:\$\{service_port\}:\$\{service_port\}"/);
  assert.match(workflow, /--publish "127\.0\.0\.1::\$\{service_port\}"/);
  assert.match(workflow, /code=DG_LOCAL_HOST_PORT_ALLOCATION_FAILED/);
  assert.match(workflow, /host_port="\$\(docker port/);
  assert.match(terraform, /network_mode\s*=\s*"awsvpc"/);
  assert.match(terraform, /containerPort = each\.value\.service_port, hostPort = each\.value\.service_port/);
  assert.doesNotMatch(terraform, /dynamic.*host.*port/is, "ECS does not remap ports across independent awsvpc tasks");
  assert.match(deployment, /resolveServicePortsAtExactSha/);
  assert.match(deployment, /service\.servicePort = resolved/);
  assert.match(deployment, /sealResolvedDeploymentConfiguration\(operation, configuration\)/);
  assert.match(repositorySource, /return await resolveServicePorts\(root, input\.services\);/, "the exact-SHA checkout remains present until asynchronous port resolution completes");
  assert.match(deployment, /snapshot\.sanitizedManifest = sanitizedManifest/);
  assert.doesNotMatch(newProject, /<span>Application port<\/span>|servicePort: Number/);
  assert.doesNotMatch(settings, /<span>Application port<\/span>|servicePort: Number/);
  assert.doesNotMatch(dto, /servicePort/);

  console.log("SERVICE_PORT_RESOLUTION=PASS ROOT=1 MULTI_SERVICE=1 PRECEDENCE=1 FAIL_CLOSED=1 HOST_PORT_ISOLATION=1 ECS_AWVPC=1 USER_PORT_INPUT=0");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
