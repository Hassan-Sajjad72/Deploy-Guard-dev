import { strict as assert } from "node:assert";
import { assertNoSecretMaterial } from "../src/orchestration-contracts/contracts/manifest.validator";

assert.doesNotThrow(() => assertNoSecretMaterial({
  secretReferenceNames: ["DATABASE_URL", "JWT_SECRET"],
  credentialReference: "binding:database:revision-1",
  configurationFingerprint: "a".repeat(64),
  fencingTokenRequired: true,
}));
assert.throws(
  () => assertNoSecretMaterial({ password: "plain-text-value" }),
  /not a permitted secret reference field/,
);
assert.throws(
  () => assertNoSecretMaterial({ accessToken: "plain-text-value" }),
  /not a permitted secret reference field/,
);
assert.throws(
  () => assertNoSecretMaterial({ nested: { privateKey: "plain-text-value" } }),
  /not a permitted secret reference field/,
);
assert.throws(
  () => assertNoSecretMaterial({ value: "AKIA1234567890ABCDEF" }),
  /secret material/,
);
assert.throws(
  () => assertNoSecretMaterial({ secretReferenceNames: ["-----BEGIN PRIVATE KEY-----"] }),
  /secret material/,
);

console.log("Manifest secret-safety verification passed");
