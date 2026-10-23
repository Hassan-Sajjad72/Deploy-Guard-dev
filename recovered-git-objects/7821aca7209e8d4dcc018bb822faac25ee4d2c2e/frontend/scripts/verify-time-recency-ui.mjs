import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { formatDuration, formatLocalDateTime, formatRelativeTime } from "../src/utils/time.js";

const instant = "2026-07-22T04:41:00.000Z";
assert.notEqual(formatLocalDateTime(instant), "—");
assert.match(formatLocalDateTime(instant), /2026/);
assert.match(formatRelativeTime(instant, Date.parse("2026-07-22T04:49:00.000Z")), /8 minutes ago/);
assert.equal(formatDuration(43_000), "43 seconds");

const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const newProject = readFileSync(new URL("../src/pages/NewProject.jsx", import.meta.url), "utf8");
const appLayout = readFileSync(new URL("../src/components/layout/AppLayout.jsx", import.meta.url), "utf8");
const pipelineLogs = readFileSync(new URL("../src/pages/ProjectPipelineLogs.jsx", import.meta.url), "utf8");
assert.match(dashboard, /response\.continueWorking|workspace\.continueWorking/);
assert.match(dashboard, /needsAttention/);
assert.match(dashboard, /recentlyViewed/);
assert.match(dashboard, /Live projects/);
assert.match(projects, /Active and needs attention/);
assert.match(projects, /Last meaningful activity/);
assert.match(projects, /Recently viewed/);
assert.doesNotMatch(projects, /project\.updatedAt/);
assert.match(newProject, /Open existing project/);
assert.match(newProject, /Create another environment/);
assert.match(newProject, /Archive existing and create fresh/);
assert.match(newProject, /active cloud resources/);
assert.match(appLayout, /recordProjectView/);
assert.match(pipelineLogs, /occurredAt[\s\S]*sequenceNumber/);

console.log("Browser-local time, recency, continuity, and duplicate-project UI verification passed.\n");
