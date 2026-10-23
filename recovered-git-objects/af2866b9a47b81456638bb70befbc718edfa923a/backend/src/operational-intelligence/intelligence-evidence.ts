import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";
import { planFingerprint } from "../planning/deployment-plan";

export const resourceFingerprint = (identity: unknown) => planFingerprint(identity || {});
type Finding = { classification: "FACT" | "HYPOTHESIS" | "MISSING_EVIDENCE"; statement: string; references: Array<{ source: string; id: string; timestamp: string | null }> };
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function buildIncident(project: any, state: any, operations: any[], events: any[], metrics: any[], now: Date) {
  const release = state.stableRelease;
  const identity = release?.runtimeIdentity || {};
  const health = state.stateAuthority?.applicationHealth;
  const latest = operations[0];
  const references = (source: string, id: unknown, timestamp: unknown) => [{ source, id: String(id || project.id), timestamp: iso(timestamp) }];
  const findings: Finding[] = [];
  if (release) findings.push({ classification: "FACT", statement: `Release ${release.id} uses immutable source ${release.commit}.`, references: references("stable_release", release.id, release.promotedAt) });
  else findings.push({ classification: "MISSING_EVIDENCE", statement: "No authoritative stable release is available.", references: [] });
  const freshHealth = iso(health?.observedAt) && now.getTime() - Date.parse(health.observedAt) <= 15 * 60_000 && Date.parse(health.observedAt) <= now.getTime();
  if (freshHealth && ["healthy", "failed"].includes(health?.status)) findings.push({ classification: "FACT", statement: `Observed application health is ${health.status}.`, references: references("application_health", release?.id, health.observedAt) });
  else findings.push({ classification: "MISSING_EVIDENCE", statement: "A recent independent application health observation is unavailable.", references: [] });
  if (latest) findings.push({ classification: "FACT", statement: `Operation ${latest.id} has recorded status ${latest.status}.`, references: references("pipeline_operation", latest.id, latest.updated_at || latest.created_at) });
  for (const event of events.slice(0, 20)) findings.push({ classification: "FACT", statement: `Recorded ${String(event.event_type || "operational").slice(0, 64)} event has status ${String(event.status).slice(0, 32)}.`, references: references("observability_event", event.id, event.created_at) });
  if (!events.length) findings.push({ classification: "MISSING_EVIDENCE", statement: "No correlated log or AWS event records were collected for this release and observation window.", references: [] });
  if (!metrics.length) findings.push({ classification: "MISSING_EVIDENCE", statement: "No correlated runtime metric observations are available.", references: [] });
  else findings.push({ classification: "FACT", statement: `${metrics.length} runtime observations are retained for this release and observation window.`, references: metrics.slice(0, 5).map((metric) => ({ source: "runtime_metric", id: String(metric.id), timestamp: iso(metric.timestamp) })) });
  const failed = Boolean((freshHealth && health?.status === "failed") || latest?.status === "failed");
  if (failed) findings.push({ classification: "HYPOTHESIS", statement: "Application configuration, dependency availability or release behavior may explain the observed failure. Root cause requires correlated logs and reproducible checks.", references: findings.filter((finding) => finding.classification === "FACT").flatMap((finding) => finding.references).slice(0, 5) });
  return { contractVersion: 1, status: failed ? "verified" : "unverified", observedAt: now.toISOString(), scope: {
    projectId: project.id, organizationId: project.organizationId || null, environment: project.environmentName || "dev",
    releaseId: release?.id || null, sourceSha: release?.commit || latest?.commit_sha || null, operationId: latest?.id || release?.operationId || null,
    bindingId: project.awsAccountBindingId || null, accountId: /^\d{12}$/.test(identity.accountId || "") ? identity.accountId : JSON.stringify(identity).match(/arn:aws(?:-[a-z]+)?:[^:]+:[^:]*:(\d{12}):/)?.[1] || null,
    region: identity.region || state.infrastructureEvidence?.region || null, resourceFingerprint: resourceFingerprint(identity),
  }, findings, recommendations: failed ? [{ statement: "Review correlated release, runtime and contract evidence before selecting an approved recovery runbook.", references: findings.flatMap((finding) => finding.references).slice(0, 5), executionAuthority: "none" }] : [], aiAuthority: "read_only", rootCauseVerified: false };
}

export function validPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const [first, second] = address.split(":").slice(0, 2).map((part) => Number.parseInt(part || "0", 16));
    return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export function safeEndpointPath(path: unknown): string {
  if (typeof path !== "string" || path.length > 256 || !/^\/[A-Za-z0-9/_~.-]*$/.test(path) || path.startsWith("//") || path.split("/").some((part) => part === "." || part === "..")) throw new BadRequestException("Endpoint must be a literal relative path without credentials, queries or templates");
  return path;
}

export type ApiProbe = { path: string; method: "GET" | "HEAD"; responses: Record<string, { schema: Record<string, any> | null }>; parameters: Array<{ name: string; type: string }> };
export function validateApiContract(input: unknown): ApiProbe[] {
  if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 100_000) throw new BadRequestException("A JSON OpenAPI contract below 100 KB is required");
  const specification = input as Record<string, any>;
  if (!/^3\.[01]\.\d+$/.test(specification.openapi) || !specification.paths || typeof specification.paths !== "object" || Array.isArray(specification.paths)) throw new BadRequestException("OpenAPI 3.0 or 3.1 paths are required");
  if (specification.servers?.length || specification.security?.length || specification.webhooks || specification.components?.securitySchemes) throw new BadRequestException("Upload a credential-free contract with relative paths; target authority comes from the verified release");
  const walk = (value: any, depth = 0) => {
    if (depth > 15) throw new BadRequestException("Contract nesting exceeds the supported limit");
    if (!value || typeof value !== "object") return;
    if (value.$ref) throw new BadRequestException("Inline schemas are required; references and remote schema loading are disabled");
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(specification);
  const probes: ApiProbe[] = [];
  for (const [path, definition] of Object.entries(specification.paths)) {
    safeEndpointPath(path);
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new BadRequestException("Invalid path definition");
    for (const [method, operation] of Object.entries(definition as Record<string, any>)) {
      if (["summary", "description"].includes(method)) continue;
      if (!["get", "head"].includes(method)) throw new BadRequestException("Only explicitly safe GET and HEAD operations are supported");
      if (!operation || typeof operation !== "object" || operation.security?.length || operation.servers?.length || operation.callbacks || operation.requestBody) throw new BadRequestException("Unsupported operation authority or request body");
      const responses: ApiProbe["responses"] = {};
      for (const [status, response] of Object.entries(operation.responses || {}) as Array<[string, any]>) {
        if (!/^[2-5]\d\d$/.test(status)) throw new BadRequestException("Explicit HTTP status responses are required");
        const content = response.content || {};
        if (Object.keys(content).some((type) => type !== "application/json")) throw new BadRequestException("Only JSON response schemas are supported");
        const schema = content["application/json"]?.schema || null;
        if (schema) validateSchema(schema);
        responses[status] = { schema };
      }
      if (!Object.keys(responses).length) throw new BadRequestException("At least one declared response is required");
      const parameters = (operation.parameters || []).map((parameter: any) => {
        if (parameter.in !== "query" || parameter.required || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(parameter.name) || !["string", "integer", "number", "boolean"].includes(parameter.schema?.type)) throw new BadRequestException("Only optional primitive query parameters are supported");
        return { name: parameter.name, type: parameter.schema.type };
      });
      if (parameters.length > 3) throw new BadRequestException("At most three query parameters per operation are supported");
      probes.push({ path, method: method.toUpperCase() as "GET" | "HEAD", responses, parameters });
    }
  }
  if (!probes.length || probes.length > 5) throw new BadRequestException("Register one to five safe endpoint operations per contract");
  return probes;
}

function validateSchema(schema: Record<string, any>) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new BadRequestException("Invalid response schema");
  if (Object.keys(schema).some((key) => !["type", "properties", "required", "items", "additionalProperties", "enum", "description", "title", "nullable", "minimum", "maximum", "minLength", "maxLength"].includes(key))) throw new BadRequestException("Schema contains unsupported assertions; simplify it to primitive, object or array checks");
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) throw new BadRequestException("A supported explicit schema type is required");
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string"))) throw new BadRequestException("Schema required names must be strings");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new BadRequestException("Additional properties must be a boolean");
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) throw new BadRequestException("Schema properties must be an object");
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new BadRequestException("Schema enum must be an array");
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") throw new BadRequestException("Schema nullable must be a boolean");
  for (const key of ["minimum", "maximum", "minLength", "maxLength"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]) || (key.endsWith("Length") && (!Number.isInteger(schema[key]) || schema[key] < 0)))) throw new BadRequestException("Invalid schema bound");
  for (const value of Object.values(schema.properties || {})) validateSchema(value as Record<string, any>);
  if (schema.items) validateSchema(schema.items);
}

export function matchesResponseSchema(value: any, schema: Record<string, any>): boolean {
  if (value === null) return schema.type === "null" || schema.nullable === true;
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some((item: any) => JSON.stringify(item) === JSON.stringify(value)))) return false;
  if (schema.type === "object") return typeof value === "object" && !Array.isArray(value) && (schema.required || []).every((key: string) => Object.prototype.hasOwnProperty.call(value, key)) && Object.entries(value).every(([key, item]) => schema.properties?.[key] ? matchesResponseSchema(item, schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === "array") return Array.isArray(value) && (!schema.items || value.every((item) => matchesResponseSchema(item, schema.items)));
  if (schema.type === "integer" || schema.type === "number") return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength);
  return typeof value === schema.type;
}

export function measuredOptimization(rows: any[], allocation: { cpu: number; memoryMiB: number; replicas: number }, start: Date, end: Date, releaseId: string, serviceId: string) {
  const duration = end.getTime() - start.getTime();
  const series = (name: string) => rows.filter((row) => row.metric_name === name && row.labels?.releaseId === releaseId && row.labels?.serviceId === serviceId && Number.isFinite(Number(row.value)) && Number(row.value) >= 0 && Number(row.value) <= 100 && Date.parse(row.timestamp) >= start.getTime() && Date.parse(row.timestamp) <= end.getTime()).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const cpu = series("ecs_cpu_utilization"); const memory = series("ecs_memory_utilization");
  const adequate = (values: any[]) => {
    if (values.length < 24 || duration < 24 * 3600_000 || duration > 7 * 24 * 3600_000) return false;
    const times = [...new Set(values.map((row) => Date.parse(row.timestamp)))];
    return times.length >= 24 && times[0] - start.getTime() <= 30 * 60_000 && end.getTime() - times[times.length - 1] <= 30 * 60_000 && times.every((time, index) => !index || time - times[index - 1] <= 30 * 60_000);
  };
  const percentile = (values: any[]) => { const sorted = values.map((row) => Number(row.value)).sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * 0.95) - 1]; };
  const base = { contractVersion: 1, window: { start: start.toISOString(), end: end.toISOString() }, releaseId, serviceId, allocation, samples: { cpu: cpu.length, memory: memory.length }, requiresNewApprovedPlan: true, executionAuthority: "none", expectedMonthlySavingsUsd: null };
  if (!adequate(cpu) || !adequate(memory) || !Number.isFinite(allocation.cpu) || !Number.isFinite(allocation.memoryMiB) || !Number.isInteger(allocation.replicas) || allocation.replicas < 1) return { ...base, status: "insufficient_evidence", confidence: "insufficient", recommendations: [], reliabilityEffects: "No change is justified by incomplete or uncorrelated observations." };
  const p95 = { cpu: percentile(cpu), memory: percentile(memory) };
  const suggestions: any[] = [];
  if (p95.cpu < 25 && p95.memory < 35) suggestions.push({ cpu: Math.max(0.25, allocation.cpu / 2), memoryMiB: allocation.memoryMiB, replicas: allocation.replicas, reason: "CPU utilization remains below 25% at p95; review a smaller CPU allocation with unchanged memory and replicas." });
  if (p95.cpu > 80 || p95.memory > 85) suggestions.push({ cpu: p95.cpu > 80 ? allocation.cpu * 2 : allocation.cpu, memoryMiB: p95.memory > 85 ? allocation.memoryMiB * 2 : allocation.memoryMiB, replicas: allocation.replicas, reason: "Sustained observed resource pressure warrants reviewing additional capacity." });
  return { ...base, status: suggestions.length ? "recommendation" : "no_change", p95, confidence: "moderate", recommendations: suggestions, reliabilityEffects: "Demand can change beyond this window. Validate supported resource combinations, availability requirements, new pricing and rollback before approving a new deployment plan.", costEffects: "Fresh itemized pricing in the new deployment plan is required; savings or increases are unknown." };
}
