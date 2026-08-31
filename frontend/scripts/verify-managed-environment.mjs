import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { parseEnvText } from "../src/utils/envFileParser.js";

for (const key of ["PORT", "HOST", "NODE_ENV", "AWS_REGION", "DATABASE_URL", "DEPLOYGUARD_PROJECT_ID", "GITHUB_TOKEN", "TF_VAR_region"]) {
  const parsed = parseEnvText(`${key}=attempted-override`, [], [key]);
  assert.equal(parsed.entries.length, 0);
  assert.deepEqual(parsed.errors, []);
  assert.match(parsed.warnings[0], /managed by DeployGuard and was ignored/);
  assert.doesNotMatch(JSON.stringify(parsed), /attempted-override/);
}
const application = parseEnvText("PORT=3000\nVITE_PUBLIC_API=https://example.test\nAPP_SECRET=masked", [], ["PORT"]);
assert.equal(application.entries.length, 2);
assert.equal(application.entries[0].scope, "build");
assert.equal(application.entries[1].isSecret, true);

const panel = await readFile(new URL("../src/components/projects/EnvironmentVariablesPanel.jsx", import.meta.url), "utf8");
const form = await readFile(new URL("../src/components/projects/EnvVarForm.jsx", import.meta.url), "utf8");
const table = await readFile(new URL("../src/components/projects/EnvVarTable.jsx", import.meta.url), "utf8");
assert.match(panel, /Managed by DeployGuard/);
assert.match(panel, /reservedVariables\.map/);
assert.match(panel, /ignoredEnvironmentNames/);
assert.match(table, /!variable\.protected && !variable\.isRequired/);
assert.doesNotMatch(table, /variable\.value/);
assert.doesNotMatch(form, /placeholder="(?:DATABASE_URL|MONGODB_URI)"/);
assert.doesNotMatch(panel, /DB_HOST=example|DB_NAME=mydb|MONGO(?:DB)?_URI=/);
assert.match(form, /Database connection aliases are managed from Database settings/);
assert.match(panel, /Database aliases are managed by DeployGuard/);
console.log("Managed environment registry presentation and reserved-variable client guard passed");
