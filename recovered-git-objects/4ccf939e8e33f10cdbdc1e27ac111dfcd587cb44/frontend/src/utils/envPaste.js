export function parseEnvPaste(value) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  String(value || "").split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const match = text.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) { errors.push(`Line ${number}: use KEY=value.`); return; }
    const [, key, raw] = match;
    if (/^(?:AWS_|GITHUB_|DEPLOYGUARD_|NODE_ENV$|PORT$|HOST$)/.test(key)) {
      errors.push(`Line ${number}: ${key} is managed by the platform or repository and cannot be supplied here.`);
      return;
    }
    if (seen.has(key)) { errors.push(`Line ${number}: ${key} is duplicated.`); return; }
    seen.add(key);
    const valuePart = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    entries.push({ key, value: valuePart, isSecret: /SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|CREDENTIAL/i.test(key) });
  });
  return { entries, errors };
}
