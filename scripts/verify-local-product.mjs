import process from "node:process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) throw new Error(`DeployGuard product verification requires Node 22; current runtime is ${process.version}.`);

const apiBase = (process.env.PRODUCT_API_URL || "http://localhost:5000").replace(/\/$/, "");
const frontendBase = (process.env.PRODUCT_FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
const prometheusBase = (process.env.PROMETHEUS_BASE_URL || "http://localhost:9090").replace(/\/$/, "");
const grafanaConfiguredUrl = process.env.GRAFANA_BASE_URL || "http://localhost:3001/d/deployguard-runtime/deployguard-runtime";
const grafanaBase = new URL(grafanaConfiguredUrl).origin;
const WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION = "deployguard.workflow-aws/v2";

if (!process.env.PRODUCT_VERIFY_ALLOW_REMOTE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase)) {
  throw new Error("Refusing to verify a non-local API. Set PRODUCT_VERIFY_ALLOW_REMOTE=true to override.");
}

async function request(url, options = {}, expected = 200) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (response.status !== expected) {
    throw new Error(`${options.method || "GET"} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

const ready = await request(`${apiBase}/api/health/ready`);
if (ready.body.status !== "ready" || ready.body.dependencies?.database?.status !== "up" || Object.keys(ready.body.dependencies || {}).some((name) => name !== "database")) {
  throw new Error(`API dependency readiness failed: ${JSON.stringify(ready.body)}`);
}
if (ready.body.capabilityContract?.stale
  || ready.body.capabilityContract?.version !== WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION
  || !/^[a-f0-9]{64}$/.test(ready.body.capabilityContract?.fingerprint || "")) {
  throw new Error(`Running AWS capability contract is invalid or stale: ${JSON.stringify(ready.body.capabilityContract)}`);
}

const frontend = await request(frontendBase);
if (!String(frontend.body).includes('id="root"')) throw new Error("Frontend HTML does not contain the React root element");

const cors = await fetch(`${apiBase}/api/auth/me`, {
  method: "OPTIONS",
  headers: { Origin: frontendBase, "Access-Control-Request-Method": "GET" },
});
if (!cors.ok || cors.headers.get("access-control-allow-origin") !== frontendBase) {
  throw new Error("Frontend origin is not accepted by the API CORS policy");
}

const oauth = await fetch(`${apiBase}/api/auth/github`, { redirect: "manual" });
if (oauth.status !== 302 || !oauth.headers.get("location")?.startsWith("https://github.com/login/oauth/authorize")) {
  throw new Error("GitHub OAuth entry did not return the configured authorization redirect");
}
await request(`${apiBase}/api/auth/me`, {}, 401);
await request(`${apiBase}/api/projects`, {}, 401);
for (const retired of ["/api/auth/signup", "/api/auth/login"]) {
  await request(`${apiBase}${retired}`, { method: "POST" }, 404);
}
let deployGuardTarget;
for (let attempt = 0; attempt < 12; attempt += 1) {
  const prometheusTargets = await request(`${prometheusBase}/api/v1/targets`);
  deployGuardTarget = prometheusTargets.body?.data?.activeTargets?.find((target) => target.labels?.job === "deployguard-aws-runtime");
  if (deployGuardTarget?.health === "up") break;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
if (!deployGuardTarget || deployGuardTarget.health !== "up") throw new Error(`DeployGuard Prometheus target is not UP: ${JSON.stringify(deployGuardTarget || null)}`);
const grafana = await request(`${grafanaBase}/api/health`);
if (grafana.body?.database !== "ok") throw new Error(`Grafana is not ready: ${JSON.stringify(grafana.body)}`);
const grafanaAuthorization = `Basic ${Buffer.from(`${process.env.GRAFANA_ADMIN_USER || "admin"}:${process.env.GRAFANA_ADMIN_PASSWORD || "deployguard-local-admin"}`).toString("base64")}`;
const grafanaSearch = await request(`${grafanaBase}/api/search?query=DeployGuard%20Runtime`, { headers: { Authorization: grafanaAuthorization } });
if (!grafanaSearch.body?.some?.((entry) => entry.uid === "deployguard-runtime" && entry.title === "DeployGuard Runtime")) {
  throw new Error(`DeployGuard Runtime dashboard is not provisioned: ${JSON.stringify(grafanaSearch.body)}`);
}

console.log("DeployGuard local product verification passed.");
console.log("  frontend: served");
console.log("  CORS: connected");
console.log("  API: ready");
console.log("  PostgreSQL: ready");
console.log("  GitHub OAuth entry: working");
console.log("  anonymous project API: rejected");
console.log("  retired email/password endpoints: absent");
console.log("  Prometheus AWS-runtime target: UP");
console.log("  Grafana DeployGuard Runtime dashboard: provisioned");
