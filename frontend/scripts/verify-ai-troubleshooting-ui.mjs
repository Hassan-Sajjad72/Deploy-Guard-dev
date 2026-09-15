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
assert.match(page, /operation\.diagnosis\.recommendedAction/, "Troubleshooting presents the current deterministic recovery action");
assert.match(page, /question\.label[\s\S]*setQuestionType\(question\.type\)/, "suggested questions retain their machine-readable question type");
assert.match(api, /questionType \? \{ questionType \}/, "question type is sent separately from display text");
assert.match(page, /aiRuntimeAnalysisCandidate === true/);
assert.match(page, /failureTroubleshootingProjection\(history\.operations \|\| \[\], list\.items \|\| \[\]\)/, "failure candidates and sessions share one history projection");
assert.match(page, /projectStatePresentation\(state\)\.state === "FAILED" \? candidates\[0\]\?\.id/, "historical failure is not selected by default after the authoritative project state recovers");
assert.match(page, /status=\{currentProjectState\}/, "page-level status comes from canonical current project state, not the selected historical failure");
assert.match(page, /<option value="">Select a failed attempt<\/option>/, "historical failure details require an explicit selection when the project is currently successful");
assert.doesNotMatch(page, /!requestedOperation \? failureSessions\[0\]/, "the first historical analysis session is not opened implicitly");
assert.match(page, /automaticAnalysisStarted\.current[\s\S]*query\.get\("analyze"\) !== "1"/, "automatic analysis is one-shot and only follows an explicit analyze link");
assert.match(page, /startTroubleshooting\(projectId, operationId\)/, "failed-attempt analysis cannot inherit a service selector from the current LIVE release");
assert.match(page, /result\?\.diagnosticDetails/);
console.log("AI_TROUBLESHOOTING_UI=PASS DIAGNOSIS_FIRST=1 SUGGESTED_QUESTION_TYPES=1 RAW_EVIDENCE_COLLAPSED=1 AUTHORITY_LABEL=1 LIVE_SERVICE_SCOPE=1 EXPLICIT_AUTO_ANALYSIS=1");
