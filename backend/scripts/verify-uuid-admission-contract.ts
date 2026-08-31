import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ParseUUIDPipe } from "@nestjs/common";

const activeProjectControllers = [
  "src/projects/projects.controller.ts",
  "src/ai-troubleshooting/ai-troubleshooting.controller.ts",
  "src/terraform-export/terraform-export.controller.ts",
  "src/notifications/notifications.controller.ts",
  "src/observability/observability.controller.ts",
];

for (const relativePath of activeProjectControllers) {
  const source = readFileSync(resolve(__dirname, "..", relativePath), "utf8");
  assert.doesNotMatch(source, /@Param\(["']projectId["']\)/, `${relativePath} must reject malformed project UUIDs before persistence access`);
  assert.doesNotMatch(source, /req\.params\.projectId/, `${relativePath} must not bypass project UUID admission through the raw request`);
  if (source.includes(":projectId")) {
    assert.match(source, /@Param\(["']projectId["']\s*,\s*ParseUUIDPipe\)/, `${relativePath} must bind projectId through ParseUUIDPipe`);
  }
}

void assert.rejects(
  () => new ParseUUIDPipe().transform("not-a-uuid", { type: "param", metatype: String, data: "projectId" }),
  (error: any) => error?.getStatus?.() === 400,
).then(() => console.log(`UUID_ADMISSION_CONTRACT=PASS ACTIVE_CONTROLLERS=${activeProjectControllers.length}`));
