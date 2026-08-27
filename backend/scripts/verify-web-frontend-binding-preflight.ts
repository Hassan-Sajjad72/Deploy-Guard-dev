import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "deployguard-web-binding-"));
const network = `dg-web-binding-${process.pid}`;
const backendImage = `deployguard-web-binding-backend:${process.pid}`;
const frontendImage = `deployguard-web-binding-next:${process.pid}`;
const backend = `dg-web-binding-backend-${process.pid}`;
const frontend = `dg-web-binding-next-${process.pid}`;

function docker(args: string[], options: { stdio?: "ignore" | "pipe" | "inherit" } = {}) {
  return execFileSync("docker", args, { stdio: options.stdio || "pipe", encoding: "utf8" });
}

try {
  const backendRoot = join(root, "backend");
  const frontendRoot = join(root, "frontend");
  mkdirSync(backendRoot, { recursive: true });
  mkdirSync(frontendRoot, { recursive: true });
  writeFileSync(join(backendRoot, "server.js"), "require('http').createServer((req,res)=>{res.end('backend-path:'+req.url)}).listen(process.env.PORT||5000,'0.0.0.0')");
  writeFileSync(join(backendRoot, "Dockerfile"), "FROM node:22-alpine\nRUN adduser -D app\nWORKDIR /app\nCOPY server.js .\nUSER app\nCMD [\"node\",\"server.js\"]\n");
  writeFileSync(join(frontendRoot, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }, scripts: { build: "next build", start: "next start" } }));
  mkdirSync(join(frontendRoot, "pages"), { recursive: true });
  writeFileSync(join(frontendRoot, "pages/index.js"), "export default function Home(){ return <main>next-ssr-web</main>; }");
  writeFileSync(join(frontendRoot, ".deployguard-web-frontend-nginx.conf"), `server {
    listen 3000; server_name _;
    location = /__deployguard/backend { proxy_pass http://127.0.0.1:5000/; }
    location /__deployguard/backend/ { proxy_pass http://127.0.0.1:5000/; }
    location / { proxy_pass http://127.0.0.1:3001; }
  }\n`);
  writeFileSync(join(frontendRoot, ".deployguard-web-frontend-entrypoint.sh"), `#!/bin/sh
set -eu
PORT=3001 HOST=0.0.0.0 npm run start -- -H 0.0.0.0 -p 3001 &
app_pid=$!
nginx -g 'pid /tmp/deployguard-nginx.pid; daemon off;' &
nginx_pid=$!
trap 'kill $app_pid $nginx_pid 2>/dev/null || true; wait $app_pid $nginx_pid 2>/dev/null || true' INT TERM EXIT
wait -n $app_pid $nginx_pid
`);
  writeFileSync(join(frontendRoot, "Dockerfile"), "FROM node:22-alpine\nRUN adduser -D app && apk add --no-cache nginx && mkdir -p /var/lib/nginx/tmp /run/nginx && chown -R app:app /var/lib/nginx /run/nginx /var/log/nginx\nWORKDIR /app\nCOPY package.json .\nRUN npm install --omit=dev --legacy-peer-deps\nCOPY pages ./pages\nRUN npm run build\nCOPY --chown=app:app .deployguard-web-frontend-nginx.conf /etc/nginx/http.d/default.conf\nCOPY --chown=app:app .deployguard-web-frontend-entrypoint.sh /usr/local/bin/deployguard-web-frontend\nRUN chmod 0755 /usr/local/bin/deployguard-web-frontend && chown -R app:app /app\nUSER app\nCMD [\"/usr/local/bin/deployguard-web-frontend\"]\n");
  docker(["build", "-q", "-t", backendImage, backendRoot]);
  docker(["build", "-q", "-t", frontendImage, frontendRoot]);
  docker(["network", "create", network]);
  docker(["run", "-d", "--name", backend, "--network", network, backendImage]);
  docker(["run", "-d", "--name", frontend, "--network", `container:${backend}`, frontendImage]);
  for (const path of ["/", "/__deployguard/backend/users", "/__deployguard/backend/api/v1", "/__deployguard/backend/v1", "/__deployguard/backend/graphql", "/__deployguard/backend"]) {
    let response = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = spawnSync("docker", ["exec", frontend, "wget", "-qO-", `http://127.0.0.1:3000${path}`], { encoding: "utf8" });
      if (result.status === 0) { response = result.stdout; break; }
    }
    if (path === "/") assert.match(response, /next-ssr-web/, "normal public traffic must be served by the real Next.js SSR runtime");
    else assert.equal(response, `backend-path:${path.replace("/__deployguard/backend", "") || "/"}`, `${path} must strip only the platform prefix`);
  }
  assert.notEqual(docker(["inspect", "-f", "{{.Config.User}}", frontend]).trim(), "", "SSR wrapper remains non-root");
  console.log("Web/SSR frontend binding preflight passed: Next-runtime image, non-root nginx wrapper, exact platform-prefix stripping, and pathname preservation.");
} finally {
  for (const target of [frontend, backend]) spawnSync("docker", ["rm", "-f", target], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  for (const image of [frontendImage, backendImage]) spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
