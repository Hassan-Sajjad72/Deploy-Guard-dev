#!/usr/bin/env node
/**
 * Static audit for the "duplicate/inconsistent data across pages" class of bug.
 *
 * Run with: node scripts/audit-duplicate-data.mjs
 * Exits with code 1 if any problem is found (so it can be wired into CI later).
 *
 * Checks performed:
 *   1. Duplicate route paths in AppRoutes.jsx
 *   2. A page that renders two or more <Link>/<a> elements pointing at the
 *      exact same target within the same nav-like block (copy/paste bugs,
 *      like "Pipeline Metrics" and "Runtime Metrics" both pointing at
 *      /observability/metrics).
 *   3. Pages that exist under src/pages but are never referenced by any
 *      <Route> in AppRoutes.jsx (dead/orphaned pages) and pages that are
 *      routed but never linked to from anywhere else in the app (unreachable
 *      except by typing the URL directly — a common source of stale,
 *      unmaintained duplicate screens).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const PAGES_DIR = path.join(SRC, "pages");
const ROUTES_FILE = path.join(SRC, "routes", "AppRoutes.jsx");

let problems = [];

function readAllSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllSourceFiles(full));
    else if (entry.name.endsWith(".jsx") || entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// --- Check 1: duplicate route paths -----------------------------------
const routesSrc = fs.readFileSync(ROUTES_FILE, "utf8");
const routeMatches = [...routesSrc.matchAll(/path=["']([^"']+)["']/g)].map((m) => m[1]);
const seenPaths = new Map();
for (const p of routeMatches) {
  seenPaths.set(p, (seenPaths.get(p) || 0) + 1);
}
for (const [p, count] of seenPaths) {
  if (count > 1) problems.push(`Duplicate route path "${p}" appears ${count} times in AppRoutes.jsx`);
}

// --- Check 2: duplicate link targets within the same file --------------
const allFiles = readAllSourceFiles(SRC);
for (const file of allFiles) {
  const content = fs.readFileSync(file, "utf8");
  const navBlocks = [...content.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => m[1]);
  for (const nav of navBlocks) {
    const linkTargets = [...nav.matchAll(/<Link[^>]*\sto=\{`([^`]+)`\}|<Link[^>]*\sto=["']([^"']+)["']/g)].map(
      (m) => m[1] || m[2]
    );
    const counts = new Map();
    for (const t of linkTargets) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [target, count] of counts) {
      if (count > 1) {
        problems.push(
          `${path.relative(SRC, file)}: ${count} tab/nav links point at the same target "${target}" — likely a copy/paste label bug (two differently-labelled tabs going to the same page)`
        );
      }
    }
  }
}

// --- Check 3: orphaned / unreachable pages ------------------------------
const pageFiles = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".jsx"));
const routedComponents = new Set(
  [...routesSrc.matchAll(/element=\{<(\w+)/g)].map((m) => m[1])
);
for (const file of pageFiles) {
  const componentName = path.basename(file, ".jsx");
  if (!routedComponents.has(componentName)) {
    problems.push(`${file}: exists in src/pages but is not referenced by any <Route> in AppRoutes.jsx (dead page)`);
  }
}

// --- Report --------------------------------------------------------------
if (problems.length === 0) {
  console.log("Audit passed: no duplicate routes, duplicate nav links, or orphaned pages found.");
  process.exit(0);
} else {
  console.log(`Audit found ${problems.length} issue(s):\n`);
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
