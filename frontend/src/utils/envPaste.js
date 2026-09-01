import { classifySubmittedEnvironmentKey, ignoredEnvironmentNotice } from "./envOwnership.js";

export function parseEnvPaste(value) {
  const entries = [];
  const errors = [];
  const ignoredVariableNames = [];
  const seen = new Set();
  String(value || "").split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const match = text.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) { errors.push(`Line ${number}: use KEY=value.`); return; }
    const [, key, raw] = match;
    const ownership = classifySubmittedEnvironmentKey(key);
    if (ownership.management !== "application") {
      ignoredVariableNames.push(ownership.key);
      return;
    }
    if (seen.has(key)) { errors.push(`Line ${number}: ${key} is duplicated.`); return; }
    seen.add(key);
    const valuePart = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    entries.push({ key, value: valuePart, isSecret: /SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|CREDENTIAL|(?:DATABASE|POSTGRES(?:QL)?|MYSQL|REDIS|MONGO(?:DB)?)_(?:URL|URI)/i.test(key) });
  });
  const ignored = [...new Set(ignoredVariableNames)].sort();
  return { entries, errors, warnings: ignoredEnvironmentNotice(ignored), ignoredVariableNames: ignored };
}
