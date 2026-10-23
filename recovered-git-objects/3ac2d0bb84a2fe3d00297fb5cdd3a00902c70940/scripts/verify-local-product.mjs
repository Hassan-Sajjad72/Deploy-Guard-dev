import process from "node:process";

const apiBase = (process.env.PRODUCT_API_URL || "http://localhost:5000").replace(/\/$/, "");
const frontendBase = (process.env.PRODUCT_FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

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

console.log("DeployGuard local product verification passed.");
console.log("  frontend: served");
console.log("  CORS: connected");
console.log("  API: ready");
console.log("  PostgreSQL: ready");
console.log("  GitHub OAuth entry: working");
console.log("  anonymous project API: rejected");
console.log("  retired email/password endpoints: absent");
