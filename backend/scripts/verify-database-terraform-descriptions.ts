import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const modulePath = resolve(__dirname, "../terraform/modules/database-service/main.tf");
const source = readFileSync(modulePath, "utf8");
const allowedCharacters = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-:/()#,@[]+=&;{}!$*");

function isSafeAwsDescription(value: string) {
  return value.length > 0 && value.length <= 255 && [...value].every((character) => allowedCharacters.has(character));
}

const descriptionAssignments = [...source.matchAll(/^\s*description\s*=\s*(.+)$/gm)];
assert.ok(descriptionAssignments.length > 0, "The database-service module must define descriptions.");

for (const assignment of descriptionAssignments) {
  const expression = assignment[1].trim();
  const literal = expression.match(/^"([^"\r\n]*)"$/);
  assert.ok(literal, `AWS description must be a static string literal: ${expression}`);
  assert.ok(isSafeAwsDescription(literal[1]), `AWS description contains an invalid character or exceeds 255 characters: ${literal[1]}`);
}

assert.match(source, /resource "aws_security_group" "database"[\s\S]*?description = "DeployGuard managed database security group"/);
assert.match(source, /resource "aws_security_group" "efs"[\s\S]*?description = "DeployGuard managed database storage security group"/);
assert.doesNotMatch(source, /description\s*=\s*"[^"\r\n]*\$\{/);
assert.doesNotMatch(source, /description\s*=\s*var\./);

const unsafeInputs = [
  "Farmer's application",
  "Unicode – punctuation",
  "Deploy → AWS",
  "x".repeat(256),
  "owner/repository|production",
  "line one\nline two",
];
for (const value of unsafeInputs) assert.equal(isSafeAwsDescription(value), false, `Expected unsafe description input: ${JSON.stringify(value)}`);

assert.equal(isSafeAwsDescription("owner/repository"), true);
assert.equal(isSafeAwsDescription("DeployGuard project-123 repository owner/repository"), true);

console.log("Database Terraform security-group descriptions are static, AWS-safe, and bounded to 255 characters.");
