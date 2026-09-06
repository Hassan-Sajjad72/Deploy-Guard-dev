import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/pages/ProjectTroubleshooting.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/platformApi.js", import.meta.url), "utf8");

for (const heading of ["Likely responsibility", "What happened", "What DeployGuard successfully completed", "Root cause", "Recommended fix", "Retry recommendation", "Suggested questions", "Evidence viewer"]) assert.match(page, new RegExp(heading));
assert.ok(page.indexOf("troubleshooting-diagnosis") < page.indexOf("Evidence viewer"), "diagnosis must render before raw evidence");
assert.match(page, /<details key=\{source\}>/, "sanitized evidence remains accessible and collapsed by default");
assert.match(page, /AI troubleshooting/);
assert.match(page, /Evidence-based explanation/);
assert.match(page, /Evidence-only explanation/);
assert.match(page, /AI explanation only\. DeployGuard's persisted deterministic diagnosis above remains authoritative\./);
assert.match(page, /operation\.diagnosis\?\.failureOwner \|\| operation\.failureOwner/, "canonical diagnosis owner takes presentation precedence with legacy fallback");
assert.match(page, /operation\.diagnosis\?\.terminalFailureCode \|\| operation\.failureCode/, "pipeline terminal code remains distinct from root cause and keeps legacy fallback");
assert.match(page, /question\.label[\s\S]*setQuestionType\(question\.type\)/, "suggested questions retain their machine-readable question type");
assert.match(api, /questionType \? \{ questionType \}/, "question type is sent separately from display text");
assert.match(page, /aiRuntimeAnalysisCandidate === true/);
assert.match(page, /automaticAnalysisStarted\.current[\s\S]*query\.get\("analyze"\) !== "1"/, "automatic analysis is one-shot and only follows an explicit analyze link");
assert.match(page, /startTroubleshooting\(projectId, operationId, selectedServiceId \|\| undefined\)/, "LIVE runtime evidence remains service scoped");
assert.match(page, /result\?\.diagnosticDetails/);
console.log("AI_TROUBLESHOOTING_UI=PASS DIAGNOSIS_FIRST=1 SUGGESTED_QUESTION_TYPES=1 RAW_EVIDENCE_COLLAPSED=1 AUTHORITY_LABEL=1 LIVE_SERVICE_SCOPE=1 EXPLICIT_AUTO_ANALYSIS=1");
