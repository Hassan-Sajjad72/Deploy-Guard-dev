/*
 * UI review harness: serves the app with Vite, answers every API request from
 * deterministic fixtures and captures each product surface at desktop and
 * phone widths. Nothing here talks to a real backend or cloud account.
 *
 *   node scripts/ui-review/capture.mjs <out-dir> [filter]
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import * as fx from "./fixtures.mjs";
import { respondFor } from "./respond.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = resolve(process.argv[2] || "ui-review-output");
const filter = process.argv[3] || "";
mkdirSync(outDir, { recursive: true });

const p = (id) => `/projects/${id}`;
export const shots = [
  ["landing", "/", { auth: false }],
  ["about", "/about", { auth: false }],
  ["projects", "/projects"],
  ["projects-empty", "/projects", { empty: true }],
  ["deploy", "/deploy"],
  ["overview-live", p(fx.ids.live)],
  ["overview-failed", p(fx.ids.failed)],
  ["overview-deploying", p(fx.ids.deploying)],
  ["overview-ready", p(fx.ids.ready)],
  ["overview-destroyed", p(fx.ids.destroyed)],
  ["overview-degraded", p(fx.ids.degraded)],
  ["pipeline-live", `${p(fx.ids.live)}/pipeline`],
  ["pipeline-failed", `${p(fx.ids.failed)}/pipeline`],
  ["pipeline-deploying", `${p(fx.ids.deploying)}/pipeline`],
  ["pipeline-ready", `${p(fx.ids.ready)}/pipeline`],
  ["infra-live", `${p(fx.ids.live)}/infrastructure`],
  ["infra-failed", `${p(fx.ids.failed)}/infrastructure`],
  ["monitoring-live", `${p(fx.ids.live)}/monitoring`],
  ["monitoring-ready", `${p(fx.ids.ready)}/monitoring`],
  ["troubleshoot-failed", `${p(fx.ids.failed)}/troubleshooting`],
  ["troubleshoot-session", `${p(fx.ids.failed)}/troubleshooting?session=ts-0001-aaaa`],
  ["troubleshoot-live", `${p(fx.ids.live)}/troubleshooting`],
  ["settings", `${p(fx.ids.live)}/settings`],
  ["billing", "/billing"],
  ["admin-overview", "/admin", { admin: true }],
  ["admin-users", "/admin?section=users", { admin: true }],
  ["admin-projects", "/admin?section=projects", { admin: true }],
  ["admin-audit", "/admin?section=audit", { admin: true }],
  ["admin-cleanup", "/admin/cleanup", { admin: true }],
  ["admin-login", "/admin/login", { auth: false }],
];

const server = await createServer({ root, logLevel: "error", server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch();
const viewports = [["desktop", { width: 1440, height: 900 }, "light"], ["dark", { width: 1440, height: 900 }, "dark"], ["mobile", { width: 390, height: 844 }, "light"]];
try {
  for (const [name, route, options = {}] of shots.filter(([name]) => !filter || name.includes(filter))) {
    for (const [label, viewport, colorScheme] of viewports) {
      const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("http://localhost:5000/**", async (routeRequest) => {
        const request = routeRequest.request();
        if (request.url().includes("/application-logs/stream")) {
          const body = `event: connected\ndata: ${JSON.stringify({ generationId: "gen-4", history: [["GET /api/listings 200 34ms"], ["GET /listings/42 200 18ms"], ["POST /api/session 201 61ms"], ["GET /health 200 2ms"], ["GET /api/listings?page=2 200 29ms"], ["warn: slow query listings.search 412ms"], ["GET /api/listings 200 31ms"]].map(([message], index) => ({ id: `l${index}`, timestamp: new Date(Date.now() - (7 - index) * 41_000).toISOString(), source: "web", message })) })}\n\n`;
          return routeRequest.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
        }
        const [status, json] = respondFor(request.url(), { ...options, withSession: route.includes("session=") });
        return routeRequest.fulfill({ status, json });
      });
      await page.goto(`http://localhost:5199${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${outDir}/${name}-${label}.png`, fullPage: true });
      if (errors.length) console.log(`! ${name}-${label}: ${errors.join(" | ")}`);
      await context.close();
    }
    console.log(`captured ${name}`);
  }
} finally {
  await browser.close();
  await server.close();
}
