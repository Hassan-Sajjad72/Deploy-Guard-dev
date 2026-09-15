#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CONTRACT_VERSION = "deployguard.docker-fallback/v1";
export const RAILPACK_VERSION = "0.38.0";
export const RAILPACK_SHA256 = "7c3f0e70ca8bf80bde87e8c30cb0171414c2b6bbd794d6f60a19cc3b71772950";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const CAPABILITIES = new Set(["RAILPACK_BUILD_APT_PACKAGES", "RAILPACK_DEPLOY_APT_PACKAGES", "RAILPACK_PACKAGES", "RAILPACK_PYTHON_VERSION", "RAILPACK_NODE_VERSION"]);

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(code, reason) { output({ contractVersion: CONTRACT_VERSION, decision: "NOT_ELIGIBLE", code, reason }); process.exitCode = 2; }

export function classifyRailpackFailure({ exitCode, evidence, evidenceComplete, railpackVersion, railpackSha256 }) {
  const base = { contractVersion: CONTRACT_VERSION, decision: "NOT_ELIGIBLE", code: "DG_RAILPACK_BUILD_FAILED", reason: "railpack_failure_not_proven_internal" };
  if (!evidenceComplete || railpackVersion !== RAILPACK_VERSION || railpackSha256 !== RAILPACK_SHA256 || !Number.isInteger(exitCode)) return base;
  if (/\b(?:context canceled|cancelled|canceled|timed? out|timeout|signal|killed|oom|out of memory)\b/i.test(evidence)) return base;
  const panic = /^panic: [^\r\n]+$/m.test(evidence)
    && /^goroutine \d+ \[running\]:$/m.test(evidence)
    && /^github\.com\/railwayapp\/railpack\/[A-Za-z0-9_./-]+\([^\r\n]*\)$/m.test(evidence);
  if (exitCode !== 2 || !panic) return base;
  return { contractVersion: CONTRACT_VERSION, decision: "ELIGIBLE", code: "DG_RAILPACK_INTERNAL_FAILURE", reason: "pinned_railpack_go_panic", evidenceDigest: sha256(evidence) };
}

function exactTemplateMatch(service, template) {
  const target = service?.buildTarget;
  const execution = target?.execution;
  const capabilities = Object.keys(service?.buildEnvironment || {}).filter((key) => CAPABILITIES.has(key)).sort();
  const expectedBuild = `npm --workspace ${target?.packageIdentity} run build`;
  const expectedStart = `npm --workspace ${target?.packageIdentity} run start`;
  return target?.resolverVersion === "deployguard.build-target/v2"
    && target?.status === "resolved"
    && target?.contract === template.contract
    && execution?.packageManager === template.packageManager
    && execution?.packageTarget === target.packageIdentity
    && PACKAGE.test(String(target.packageIdentity || ""))
    && execution?.buildCommand === expectedBuild
    && execution?.startCommand === expectedStart
    && target.workspaceRoot === target.buildRoot
    && target.installRoot === target.buildRoot
    && service?.buildEnvironment?.RAILPACK_NODE_VERSION === template.runtimeVersion
    && JSON.stringify(capabilities) === JSON.stringify([...template.supportedCapabilities].sort())
    && SHA256.test(String(target.fingerprint || ""))
    && UUID.test(String(service?.buildTargetRevisionId || ""))
    && UUID.test(String(service?.runtimeConfigRevisionId || ""))
    && SHA256.test(String(service?.runtimeConfigFingerprint || ""));
}

export function selectCertifiedTemplate(service, manifest, rootDirectory) {
  if (manifest?.contractVersion !== CONTRACT_VERSION || !Array.isArray(manifest.templates)) return { decision: "NOT_ELIGIBLE", code: "DG_DOCKER_FALLBACK_CONTRACT_INVALID", reason: "template_manifest_invalid" };
  const matches = manifest.templates.filter((template) => exactTemplateMatch(service, template));
  if (matches.length === 0) return { decision: "NOT_ELIGIBLE", code: "DG_DOCKER_FALLBACK_UNSUPPORTED", reason: "no_exact_certified_contract" };
  if (matches.length !== 1) return { decision: "NOT_ELIGIBLE", code: "DG_DOCKER_FALLBACK_CONTRACT_INVALID", reason: "ambiguous_certified_contract" };
  const template = matches[0];
  if (!template || typeof template.path !== "string" || !SHA256.test(String(template.sha256 || ""))) return { decision: "NOT_ELIGIBLE", code: "DG_DOCKER_FALLBACK_CONTRACT_INVALID", reason: "template_entry_invalid" };
  const path = resolve(rootDirectory, template.path);
  if (!existsSync(path) || sha256(readFileSync(path)) !== template.sha256) return { decision: "NOT_ELIGIBLE", code: "DG_DOCKER_FALLBACK_TEMPLATE_INTEGRITY_FAILED", reason: "template_digest_mismatch" };
  return { decision: "ELIGIBLE", code: "DG_RAILPACK_INTERNAL_FAILURE", reason: "exact_certified_contract", templateId: template.id, templateVersion: template.version, templateDigest: template.sha256, templatePath: path };
}

function args(values) { const result = {}; for (let index = 0; index < values.length; index += 2) result[values[index]?.replace(/^--/, "")] = values[index + 1]; return result; }
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const command = process.argv[2]; const values = args(process.argv.slice(3));
  if (command === "classify") {
    const result = classifyRailpackFailure({ exitCode: Number(values["exit-code"]), evidence: readFileSync(values.evidence, "utf8"), evidenceComplete: values.complete === "true", railpackVersion: values["railpack-version"], railpackSha256: values["railpack-sha256"] });
    output(result); process.exitCode = result.decision === "ELIGIBLE" ? 0 : 2;
  } else if (command === "select") {
    const result = selectCertifiedTemplate(json(values.service), json(values.manifest), values.root);
    if (result.decision === "ELIGIBLE") {
      try { closeSync(openSync(values.ledger, "wx", 0o600)); } catch { fail("DG_DOCKER_FALLBACK_ALREADY_ATTEMPTED", "service_fallback_attempt_already_recorded"); process.exit(); }
    }
    output(result); process.exitCode = result.decision === "ELIGIBLE" ? 0 : 2;
  } else fail("DG_DOCKER_FALLBACK_CONTRACT_INVALID", "unknown_contract_command");
}
