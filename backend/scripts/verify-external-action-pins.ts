import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APPROVED_ACTIONS = new Map<string, string>([
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["aws-actions/configure-aws-credentials", "e3dd6a429d7300a6a4c196c26e071d42e0343502"],
  ["hashicorp/setup-terraform", "b9cd54a3c349d3f38e8881555d616ced269862dd"],
  ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
]);
const APPROVED_ACTION_OCCURRENCES = new Map<string, number>([
  ["actions/checkout", 1],
  ["aws-actions/configure-aws-credentials", 1],
  ["hashicorp/setup-terraform", 1],
  ["actions/upload-artifact", 2],
]);

type ActionReference = { repository: string; sha: string };

function externalActionReferences(workflow: string): ActionReference[] {
  return [...workflow.matchAll(/^\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => ({ repository: match[1], sha: match[2] }));
}

function assertApprovedReferences(workflow: string) {
  const references = externalActionReferences(workflow);
  assert.equal(references.length, [...APPROVED_ACTION_OCCURRENCES.values()].reduce((sum, count) => sum + count, 0), "every direct external action call site must be represented by the approved immutable set");
  for (const reference of references) {
    assert.match(reference.sha, /^[0-9a-f]{40}$/, `${reference.repository} must use an immutable 40-character commit SHA`);
    assert.equal(reference.sha, APPROVED_ACTIONS.get(reference.repository), `${reference.repository} is not pinned to its reviewed commit`);
  }
  for (const repository of APPROVED_ACTIONS.keys()) {
    assert.equal(references.filter((reference) => reference.repository === repository).length, APPROVED_ACTION_OCCURRENCES.get(repository), `${repository} call-site count does not match the reviewed workflow`);
  }
  return references;
}

async function actionMetadataExists(reference: ActionReference) {
  const headers = { Accept: "application/vnd.github.raw+json", "User-Agent": "DeployGuard-Workflow-Certification", "X-GitHub-Api-Version": "2022-11-28" };
  for (const path of ["action.yml", "action.yaml"]) {
    const response = await fetch(`https://api.github.com/repos/${reference.repository}/contents/${path}?ref=${reference.sha}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return true;
    if (response.status !== 404) throw new Error(`${reference.repository}@${reference.sha} could not be verified (${response.status}).`);
  }
  return false;
}

async function run() {
  const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  const references = assertApprovedReferences(workflow);
  assert.throws(
    () => assertApprovedReferences(workflow.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4")),
    /immutable 40-character commit SHA/,
    "a nonexistent or floating third-party action ref must fail certification",
  );
  for (const reference of references) {
    assert.equal(await actionMetadataExists(reference), true, `${reference.repository}@${reference.sha} must expose action metadata upstream`);
  }
  console.log(`External action certification passed: ${references.length} reviewed call sites across ${APPROVED_ACTIONS.size} approved immutable actions resolve upstream.`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : "External action certification failed.");
  process.exitCode = 1;
});
