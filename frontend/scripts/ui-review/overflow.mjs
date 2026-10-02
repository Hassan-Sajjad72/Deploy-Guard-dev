/* Lists elements wider than a 390px viewport on the given routes (layout regression probe). */
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fx from "./fixtures.mjs";
import { respondFor } from "./respond.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routes = process.argv.slice(2);
const server = await createServer({ root, logLevel: "error", server: { port: 5198, strictPort: true } });
await server.listen();
const browser = await chromium.launch();
for (const route of routes) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("http://localhost:5000/**", (request) => { const [status, json] = respondFor(request.request().url(), { admin: route.startsWith("/admin") }); return request.fulfill({ status, json }); });
  await page.goto(`http://localhost:5198${route}`, { waitUntil: "networkidle" });
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").join(".")} right=${Math.round(el.getBoundingClientRect().right)}`));
  console.log(route, wide.length ? wide : "ok");
  await page.close();
}
await browser.close();
await server.close();
void fx;
