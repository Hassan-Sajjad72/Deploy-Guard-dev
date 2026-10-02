import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { formatDuration, formatLocalDateTime, formatRelativeTime } from "../src/utils/time.js";

const instant = "2026-07-22T04:41:00.000Z";
assert.notEqual(formatLocalDateTime(instant), "—");
assert.match(formatLocalDateTime(instant), /2026/);
assert.match(formatRelativeTime(instant, Date.parse("2026-07-22T04:49:00.000Z")), /8 minutes ago/);
assert.equal(formatDuration(43_000), "43 seconds");

const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const newProject = readFileSync(new URL("../src/pages/NewProject.jsx", import.meta.url), "utf8");
const appLayout = readFileSync(new URL("../src/components/layout/AppLayout.jsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");

assert.match(projects, /rows\.filter/);
assert.match(projects, /projectStatePresentation\(summary\.currentState\)/);
assert.match(projects, /<Time value=\{activity\} \/>/);
const timeComponent = readFileSync(new URL("../src/components/common/Time.jsx", import.meta.url), "utf8");
assert.match(timeComponent, /<time className=\{className\} dateTime=\{value\} title=\{exact\}>/, "relative times keep the exact timestamp available");
assert.match(projects, /project\.activity\?\.lastMeaningfulActivityAt/);
assert.match(timeComponent, /formatRelativeTime\(value\)/);
assert.doesNotMatch(projects, /project\.updatedAt/);
assert.match(newProject, /caught\.payload\.existingProject/);
assert.match(newProject, /deployGithubActionsDeployment\(readiness\.project\.id\)/);
assert.doesNotMatch(newProject, /Create another environment|Archive existing and create fresh/);
assert.match(appLayout, /recordProjectView/);
assert.match(routes, /<Route element=\{<Navigate replace to="\/projects" \/>\} path="\/dashboard"/);

console.log("Browser-local time, project recency, and idempotent existing-project continuation verification passed.");
