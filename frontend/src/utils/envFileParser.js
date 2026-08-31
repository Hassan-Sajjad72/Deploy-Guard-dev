import { classifySubmittedEnvironmentKey, ignoredEnvironmentNotice } from "./envOwnership.js";

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function classifyEnvironmentVariable(key) {
  const normalized = String(key || "").trim().toUpperCase();
  const isPublicBuild = /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/.test(normalized);
  const isSecret = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|CREDENTIAL|AUTH_KEY)/.test(normalized);
  return {
    key: normalized,
    scope: isPublicBuild ? "build" : "runtime",
    isSecret,
    isRequired: false,
  };
}

export function parseEnvText(text, _knownKeys = [], reservedKeys = [], repositoryOwnedKeys = []) {
  const entries = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const ignoredVariableNames = [];

  String(text || "").split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const source = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = source.indexOf("=");
    if (separator < 1) {
      errors.push(`Line ${index + 1}: expected KEY=VALUE.`);
      return;
    }
    const key = source.slice(0, separator).trim().toUpperCase();
    let value = source.slice(separator + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      errors.push(`Line ${index + 1}: ${key || "key"} is not a valid variable name.`);
      return;
    }
    const ownership = classifySubmittedEnvironmentKey(key, reservedKeys, repositoryOwnedKeys);
    if (ownership.management !== "application") {
      ignoredVariableNames.push(ownership.key);
      return;
    }
    if (seen.has(key)) {
      errors.push(`Line ${index + 1}: duplicate key ${key}.`);
      return;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) {
      errors.push(`Line ${index + 1}: ${key} needs a value.`);
      return;
    }
    seen.add(key);
    entries.push({ ...classifyEnvironmentVariable(key), value });
  });

  const ignored = [...new Set(ignoredVariableNames)].sort();
  return { entries, errors, warnings: [...new Set([...warnings, ...ignoredEnvironmentNotice(ignored)])], ignoredVariableNames: ignored };
}
