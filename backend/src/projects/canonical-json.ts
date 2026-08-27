import { createHash } from "crypto";

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalize(value: unknown, path: string): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value as null | boolean | string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must contain only JSON values.`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => {
    if (item === undefined) throw new Error(`${path}.${key} cannot be undefined.`);
    return [key, normalize(item, `${path}.${key}`)];
  }));
}

export function canonicalJson(value: unknown) { return JSON.stringify(normalize(value, "$")); }
export function canonicalizeJson<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
export function canonicalSha256(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
