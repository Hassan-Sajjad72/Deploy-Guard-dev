import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type MockProject = { id: string; name: string; repositoryFullName: string; targetBranch: string; environmentName: string; applicationEntryPointServiceId: string; services: Array<{ id: string; name: string; serviceDirectory: string; servicePort?: number | null }> };
const projects: MockProject[] = [];
const states = new Map<string, { operationId: string; type: "deploy" | "destroy"; polls: number }>();
const deployCounts = new Map<string, number>();
const destroyCounts = new Map<string, number>();
let activeDeployAdmissions = 0;
let maxDeployAdmissions = 0;
let activeDestroyAdmissions = 0;
let maxDestroyAdmissions = 0;

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/apps/")) { response.writeHead(200); response.end("ok"); return; }
  if (request.headers["x-user-id"] !== "42") { json(response, 401, { message: "Authentication required" }); return; }
  if (request.method === "GET" && url.pathname === "/api/projects") { json(response, 200, { projects }); return; }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const input = await body(request);
    const project: MockProject = {
      id: `00000000-0000-4000-8000-${String(projects.length + 1).padStart(12, "0")}`,
      name: input.name,
      repositoryFullName: input.repositoryFullName,
      targetBranch: input.targetBranch,
      environmentName: input.environmentName,
      applicationEntryPointServiceId: input.applicationEntryPointServiceId,
      services: input.services,
    };
    projects.push(project); json(response, 201, { project }); return;
  }
  if (request.method === "POST" && /\/env\/bulk$/.test(url.pathname)) { await body(request); json(response, 201, { variables: [] }); return; }
  const deploy = url.pathname.match(/^\/api\/projects\/([^/]+)\/deploy$/);
  if (request.method === "POST" && deploy) {
    const projectId = deploy[1];
    deployCounts.set(projectId, (deployCounts.get(projectId) || 0) + 1);
    activeDeployAdmissions += 1; maxDeployAdmissions = Math.max(maxDeployAdmissions, activeDeployAdmissions);
    await new Promise((done) => setTimeout(done, 80)); activeDeployAdmissions -= 1;
    const operationId = `10000000-0000-4000-8000-${projectId.slice(-12)}`;
    states.set(projectId, { operationId, type: "deploy", polls: 0 });
    json(response, 201, { deployment: { state: "accepted", operation: { id: operationId } } }); return;
  }
  const destroy = url.pathname.match(/^\/api\/projects\/([^/]+)\/deploy\/destroy$/);
  if (request.method === "POST" && destroy) {
    const projectId = destroy[1];
    destroyCounts.set(projectId, (destroyCounts.get(projectId) || 0) + 1);
    activeDestroyAdmissions += 1; maxDestroyAdmissions = Math.max(maxDestroyAdmissions, activeDestroyAdmissions);
    await new Promise((done) => setTimeout(done, 80)); activeDestroyAdmissions -= 1;
    const operationId = `20000000-0000-4000-8000-${projectId.slice(-12)}`;
    states.set(projectId, { operationId, type: "destroy", polls: 0 });
    json(response, 201, { deployment: { state: "accepted", operation: { id: operationId } } }); return;
  }
  const current = url.pathname.match(/^\/api\/projects\/([^/]+)\/current-state$/);
  if (request.method === "GET" && current) {
    const projectId = current[1];
    const state = states.get(projectId)!; state.polls += 1;
    if (state.polls === 1) { json(response, 503, { message: "temporary polling outage" }); return; }
    const project = projects.find((candidate) => candidate.id === projectId)!;
    if (state.type === "destroy") {
      json(response, 200, { developerState: "destroyed", developerMessage: "Destroyed", latestAttempt: { operationId: state.operationId, operationType: "destroy", outcome: "completed" } }); return;
    }
    const failed = project.name === "app-3";
    if (failed) {
      json(response, 200, { developerState: "failed_application", developerMessage: "Safe build failure", applicationError: { category: "build", message: "Safe build failure" }, latestAttempt: { operationId: state.operationId, generationId: null, operationType: "deploy", outcome: "blocked", failureOwner: "application", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:03.000Z", workflowStages: [{ key: "railpack_build", status: "failed" }] } }); return;
    }
    const generationId = `30000000-0000-4000-8000-${projectId.slice(-12)}`;
    json(response, 200, { developerState: "live", stableUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/apps/${project.name}`, latestAttempt: { operationId: state.operationId, generationId, operationType: "deploy", outcome: "completed", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:02.000Z" }, stableRelease: { id: `40000000-0000-4000-8000-${projectId.slice(-12)}`, operationId: state.operationId, generationId } }); return;
  }
  json(response, 404, { message: "not found" });
});

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const temporary = mkdtempSync(join(tmpdir(), "deployguard-live-matrix-"));
  const matrix = join(temporary, "apps.json");
  const report = join(temporary, "report.json");
  const run = async (matrixPath: string, reportPath: string, extraArgs: string[] = []) => {
    const child = spawn(process.execPath, ["-r", "ts-node/register", resolve(__dirname, "certify-live-app-matrix.ts"), "--matrix", matrixPath, "--api-url", `http://127.0.0.1:${port}`, "--concurrency", "5", "--poll-interval-ms", "10", "--request-timeout-ms", "1000", "--timeout-seconds", "5", "--output", reportPath, ...extraArgs], {
      cwd: resolve(__dirname, ".."), env: { ...process.env, DEPLOYGUARD_USER_ID: "42" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); });
    return { exitCode, stdout, stderr, output: JSON.parse(readFileSync(reportPath, "utf8")) };
  };
  writeFileSync(matrix, JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
    name: `app-${index + 1}`,
    repository: `fixture/app-${index + 1}`,
    branch: "main",
    serviceDirectory: ".",
    env: { [`APP_${index + 1}`]: `value-${index + 1}` },
  }))));
  const { exitCode, stdout, stderr, output } = await run(matrix, report, ["--destroy"]);
  assert.equal(exitCode, 1, stderr);
  assert.deepEqual(output.summary, { total: 5, passed: 4, failed: 1 });
  assert.equal(maxDeployAdmissions, 5, "five different projects must submit deployments concurrently");
  assert.equal(maxDestroyAdmissions, 4, "all successful projects must submit Destroy concurrently");
  assert.equal([...deployCounts.values()].every((count) => count === 1), true, "each project receives exactly one deploy operation");
  assert.equal([...destroyCounts.values()].every((count) => count === 1), true, "each successful project receives exactly one destroy operation");
  assert.equal(output.results.find((result: { name: string }) => result.name === "app-3").deployment.failureOwner, "application");
  assert.equal(output.results.filter((result: { status: string }) => result.status === "PASS").every((result: { destroy: { status: string }; deployment: { reachable: boolean } }) => result.destroy.status === "DESTROYED" && result.deployment.reachable), true);
  assert.match(stdout, /JSON_REPORT=/);
  assert.doesNotMatch(`${stdout}\n${stderr}\n${JSON.stringify(output)}`, /value-[1-5]/, "environment values must not appear in logs or reports");

  const existingMatrix = join(temporary, "existing.json");
  writeFileSync(existingMatrix, JSON.stringify([{
    name: projects[0].name,
    projectId: projects[0].id,
    repository: projects[0].repositoryFullName,
    branch: projects[0].targetBranch,
    serviceDirectory: ".",
  }]));
  const destroyCountBeforeExisting = destroyCounts.get(projects[0].id) || 0;
  const existingDefault = await run(existingMatrix, join(temporary, "existing-default.json"), ["--destroy"]);
  assert.equal(existingDefault.exitCode, 0, existingDefault.stderr);
  assert.equal(existingDefault.output.results[0].projectSource, "existing");
  assert.deepEqual(existingDefault.output.results[0].destroy, { requested: false, status: "SKIPPED", operationId: null });
  assert.equal(destroyCounts.get(projects[0].id), destroyCountBeforeExisting, "existing project must not be destroyed by --destroy alone");

  const existingExplicit = await run(existingMatrix, join(temporary, "existing-explicit.json"), ["--destroy", "--destroy-existing"]);
  assert.equal(existingExplicit.exitCode, 0, existingExplicit.stderr);
  assert.equal(existingExplicit.output.results[0].projectSource, "existing");
  assert.equal(existingExplicit.output.results[0].destroy.status, "DESTROYED");
  assert.equal(destroyCounts.get(projects[0].id), destroyCountBeforeExisting + 1, "--destroy-existing must explicitly admit existing project destruction");
  console.log("Live app matrix runner verification passed.");
  console.log("DEPLOY_CONCURRENCY=5 DESTROY_CONCURRENCY=4 TRANSIENT_POLL_RETRY=PASS FAILED_APP_ISOLATION=PASS SAME_PROJECT_DUPLICATES=0 SECRET_SAFE=PASS CREATED_DESTROY=PASS EXISTING_DESTROY_DEFAULT=SKIPPED EXISTING_DESTROY_EXPLICIT=PASS");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
