import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { CanonicalBuildTarget } from "./build-target";
import { aliasesFor, ConfigurationOwner, isSecretConfigurationKey, normalizeConfigurationKey, reservedVariable } from "./configuration-ownership";

export type RequirementScope = "build" | "runtime" | "both";
export type RequirementRecord = { serviceId: string; key: string; required: boolean; secret: boolean; scope: RequirementScope; owner: ConfigurationOwner; evidence: string[]; resolvedStatus: "provided" | "missing" | "blocked"; resolutionSource: string; reason: string };
export type RequirementAdmission = { status: "READY" | "INPUT_REQUIRED" | "BLOCKED"; fingerprint: string; requirements: RequirementRecord[]; unresolvedRequired: string[]; prohibitedOverrides: string[]; duplicateConflicts: string[]; validationBlockers: string[] };
export class DeploymentRequirementAdmissionError extends Error { constructor(readonly admission: RequirementAdmission) { super(admission.status === "INPUT_REQUIRED" ? `Required configuration is missing: ${admission.unresolvedRequired.join(", ")}.` : admission.validationBlockers[0] || admission.prohibitedOverrides[0] || "Deployment requirement admission is blocked."); } }
type Variable = { serviceId: string; key: string; isSecret: boolean; scope: RequirementScope };
type Database = { engine: "postgres" | "mysql" | "mongodb"; attachedServiceId: string } | null;
type Declared = { key: string; required: boolean; secret: boolean; scope: RequirementScope; source: string; defaultProvided: boolean };

@Injectable()
export class DeploymentRequirementResolverService {
  async resolve(root: string, input: { sourceSha: string; targets: Array<{ serviceId: string; target: CanonicalBuildTarget }>; variables: Variable[]; managedDatabase: Database }): Promise<RequirementAdmission> {
    const records: RequirementRecord[] = []; const blockers: string[] = []; const prohibited: string[] = []; const duplicate: string[] = [];
    for (const item of input.targets.sort((a, b) => a.serviceId.localeCompare(b.serviceId))) {
      const declared = await this.declarations(root, item.target);
      const byKey = new Map<string, Declared>();
      for (const requirement of declared) {
        const prior = byKey.get(requirement.key);
        if (prior && (prior.secret !== requirement.secret || prior.scope !== requirement.scope)) duplicate.push(`${item.serviceId}:${requirement.key}`);
        else if (prior) { prior.required ||= requirement.required; prior.defaultProvided &&= requirement.defaultProvided; prior.source += `, ${requirement.source}`; }
        else byKey.set(requirement.key, { ...requirement });
      }
      for (const key of ["PORT", "HOST"]) byKey.set(key, { key, required: true, secret: false, scope: "runtime", source: "DeployGuard platform contract", defaultProvided: false });
      if (input.managedDatabase?.attachedServiceId === item.serviceId) for (const property of ["host", "port", "username", "password", "database", "url"] as const) for (const key of aliasesFor(input.managedDatabase.engine, property)) byKey.set(key, { key, required: true, secret: property === "password" || property === "url", scope: "runtime", source: `managed ${input.managedDatabase.engine} binding`, defaultProvided: false });
      for (const value of [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
        const configured = input.variables.find((variable) => variable.serviceId === item.serviceId && normalizeConfigurationKey(variable.key) === value.key);
        const reserved = reservedVariable(value.key, input.managedDatabase?.attachedServiceId === item.serviceId ? input.managedDatabase.engine : null);
        const managed = input.managedDatabase?.attachedServiceId === item.serviceId && aliasesFor(input.managedDatabase.engine, "url").concat(aliasesFor(input.managedDatabase.engine, "host"), aliasesFor(input.managedDatabase.engine, "port"), aliasesFor(input.managedDatabase.engine, "username"), aliasesFor(input.managedDatabase.engine, "password"), aliasesFor(input.managedDatabase.engine, "database")).includes(value.key);
        if (configured && (reserved || managed)) { prohibited.push(`${item.serviceId}:${value.key}`); records.push(this.record(item.serviceId, value, reserved ? "platform" : "managed_service", "blocked", "prohibited_override", `${value.key} is managed by DeployGuard.`)); continue; }
        if (managed) { records.push(this.record(item.serviceId, value, "managed_service", "provided", "managed_service", `${value.key} is provided by the attached managed database.`)); continue; }
        if (reserved) { records.push(this.record(item.serviceId, value, "platform", "provided", "platform", `${value.key} is provided by DeployGuard.`)); continue; }
        if (configured) { records.push(this.record(item.serviceId, value, value.required ? "user_required" : "user_optional", "provided", "user_configuration", "Configured for this service.")); continue; }
        if (value.defaultProvided && !value.secret) { records.push(this.record(item.serviceId, value, "repository_default", "provided", "repository_default", "A repository-owned non-secret default is declared.")); continue; }
        records.push(this.record(item.serviceId, value, value.required ? "user_required" : "user_optional", value.required ? "missing" : "provided", value.required ? "missing" : "optional", value.required ? "Required user configuration is absent." : "Optional configuration is absent."));
      }
    }
    const unresolved = records.filter((item) => item.resolvedStatus === "missing").map((item) => `${item.serviceId}:${item.key}`).sort();
    const validationBlockers = [...new Set(blockers)].sort(); const conflicts = [...new Set(duplicate)].sort(); const prohibitedOverrides = [...new Set(prohibited)].sort();
    const status = validationBlockers.length || conflicts.length || prohibitedOverrides.length ? "BLOCKED" : unresolved.length ? "INPUT_REQUIRED" : "READY";
    const stable = { sourceSha: input.sourceSha.toLowerCase(), targets: input.targets.map((item) => ({ serviceId: item.serviceId, revision: item.target.fingerprint })).sort((a, b) => a.serviceId.localeCompare(b.serviceId)), variables: input.variables.map((item) => ({ serviceId: item.serviceId, key: normalizeConfigurationKey(item.key), secret: item.isSecret, scope: item.scope })).sort((a, b) => `${a.serviceId}:${a.key}`.localeCompare(`${b.serviceId}:${b.key}`)), records, unresolved, prohibitedOverrides, conflicts, validationBlockers };
    return { status, fingerprint: createHash("sha256").update(JSON.stringify(stable)).digest("hex"), requirements: records, unresolvedRequired: unresolved, prohibitedOverrides, duplicateConflicts: conflicts, validationBlockers };
  }
  private record(serviceId: string, item: Declared, owner: ConfigurationOwner, resolvedStatus: RequirementRecord["resolvedStatus"], resolutionSource: string, reason: string): RequirementRecord { return { serviceId, key: item.key, required: item.required, secret: item.secret, scope: item.scope, owner, evidence: item.source.split(", ").sort(), resolvedStatus, resolutionSource, reason }; }
  private async declarations(root: string, target: CanonicalBuildTarget) {
    const directories = [...new Set([target.serviceDirectory, target.buildRoot].map((path) => path === "." ? root : join(root, ...path.split("/"))))]; const values: Declared[] = [];
    for (const directory of directories) {
      for (const filename of [".env.example", ".env.sample", ".env.template"]) { const text = await readFile(join(directory, filename), "utf8").catch(() => ""); let optional = false; for (const line of text.split(/\r?\n/)) { if (/^\s*#/.test(line)) { optional = /optional/i.test(line); continue; } const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!match) continue; const key = normalizeConfigurationKey(match[1]); const value = match[2].trim().replace(/^['"]|['"]$/g, ""); values.push({ key, required: !optional && !value, secret: isSecretConfigurationKey(key), scope: /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/.test(key) ? "build" : "runtime", source: `${target.serviceDirectory}/${filename}`, defaultProvided: Boolean(value) }); optional = false; } }
      const dockerfile = await readFile(join(directory, "Dockerfile"), "utf8").catch(() => ""); for (const line of dockerfile.split(/\r?\n/)) { const arg = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?\s*$/i); const env = line.match(/^\s*ENV\s+([A-Za-z_][A-Za-z0-9_]*)(?:[ =](.*))?\s*$/i); const match = arg || env; if (!match) continue; const key = normalizeConfigurationKey(match[1]); const value = (match[2] || "").trim(); values.push({ key, required: !value, secret: isSecretConfigurationKey(key), scope: arg ? "build" : "runtime", source: `${target.serviceDirectory}/Dockerfile`, defaultProvided: Boolean(value) }); }
      for (const filename of ["deployguard.requirements.json", ".deployguard/requirements.json", "app.json"]) { const raw = await readFile(join(directory, filename), "utf8").catch(() => ""); if (!raw) continue; try { const parsed = JSON.parse(raw) as any; const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : parsed.env && typeof parsed.env === "object" ? Object.entries(parsed.env).map(([key, value]) => ({ key, ...(typeof value === "object" ? value : {}) })) : []; for (const item of requirements) if (item && typeof item.key === "string") { const key = normalizeConfigurationKey(item.key); values.push({ key, required: item.required === true || item.generator === true, secret: item.secret === true || isSecretConfigurationKey(key), scope: ["build", "runtime", "both"].includes(item.scope) ? item.scope : "runtime", source: `${target.serviceDirectory}/${filename}`, defaultProvided: typeof item.default === "string" || typeof item.value === "string" }); } } catch { /* malformed optional repository metadata is Railpack/source territory, not inferred here */ } }
    }
    return values;
  }
}
