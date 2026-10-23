import { strict as assert } from "assert";
import { readFileSync } from "fs";

const controller = readFileSync("src/projects/projects.controller.ts", "utf8");
const deployment = readFileSync("src/projects/github-actions-deployment.service.ts", "utf8");

const detectionStart = controller.indexOf('async detectStack');
const detectionEnd = controller.indexOf('@Get(":projectId/detection-profile")');
const detection = controller.slice(detectionStart, detectionEnd);
assert.ok(detectionStart >= 0 && detectionEnd > detectionStart, "detect-stack route must exist");
assert.ok(detection.indexOf("runDetection") < detection.indexOf("ensureDeployguardWorkflow"), "detection must finish before any workflow mutation");
assert.match(detection, /contract\?\.deployable\s*\?\s*await this\.projectsService\.ensureDeployguardWorkflow/);
assert.match(deployment, /const contract = await this\.deploymentContracts\.requireForProject\(projectId\);[\s\S]{0,160}this\.deploymentContracts\.assertDeployable\(contract, project\);[\s\S]{0,240}ensureWorkflow/);

console.log("Detection contract gate verification passed.");
