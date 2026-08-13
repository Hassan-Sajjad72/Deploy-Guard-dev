import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { V1InfrastructureManifestApplyService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-apply.service";

const references = [
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:database-url-AbCd12",
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:database-password-EfGh34",
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:jwt-IjKl56",
].sort();
const roleName = "dg-11111111111141118111-dev-exec";
const policyName = "deployguard-runtime-secret-access";
const policy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{
    Sid: "ReadExactRuntimeSecrets",
    Effect: "Allow",
    Action: ["secretsmanager:GetSecretValue"],
    Resource: references,
  }],
});
const parentOutputs = {
  ecs_execution_role_arn: `arn:aws:iam::123456789012:role/${roleName}`,
  database_url_secret_arn: references[0],
  database_password_secret_arn: references[1],
  application_jwt_secret_arn: references[2],
  ecs_cluster_arn: "fixture-cluster",
};
const parent = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentName: "dev",
  status: "applied",
  terraformOutputs: parentOutputs,
  terraformOutputsHash: canonicalSha256(parentOutputs),
  resourceCount: 56,
};
const manifest: any = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: parent.projectId,
  environmentName: "dev",
  revision: "2",
  status: "planned",
  parentManifestId: parent.id,
  stateBackend: "s3",
  stateKey: `projects/${parent.projectId}/dev/v1/2.tfstate`,
  desiredSpec: { database: { mode: "managed" } },
  changeSet: {
    fromManifestId: parent.id,
    changedPaths: ["iamPolicyRevision"],
    categories: ["iam"],
    destructivePaths: [],
  },
  planArtifactReference: {
    secretAccess: {
      boundary: "execution_role_exact_secret_read",
      executionRoleName: roleName,
      referenceCount: 3,
      referenceFingerprint: canonicalSha256(references),
      parentManifestId: parent.id,
      parentOutputsHash: parent.terraformOutputsHash,
    },
  },
};

void (async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dg-iam-apply-"));
  await mkdir(join(workspace, ".terraform"));
  await writeFile(join(workspace, ".terraform", "terraform.tfstate"), JSON.stringify({
    backend: {
      type: "s3",
      config: {
        bucket: "fixture-state",
        key: manifest.stateKey,
        region: "us-east-1",
        use_lockfile: true,
      },
    },
  }));
  await writeFile(join(workspace, "tfplan"), "exact-addon-plan");
  const planHash = createHash("sha256").update("exact-addon-plan").digest("hex");
  const show = (resourcePolicy = policy, extras: any[] = []) => JSON.stringify({
    variables: {
      offline_plan_mode: { value: false },
      secret_arns: { value: references },
    },
    resource_changes: [{
      address: "aws_iam_role_policy.runtime_secret_access",
      type: "aws_iam_role_policy",
      mode: "managed",
      change: { actions: ["create"], after: { role: roleName, policy: resourcePolicy } },
    }, ...extras],
  });
  let showJson = show();
  const terraform = {
    runTerraformShowJson: async () => ({ stdout: showJson, stderr: "" }),
    runTerraformShowStateJson: async () => ({
      stdout: JSON.stringify({
        values: {
          root_module: {
            resources: [{
              mode: "managed",
              type: "aws_iam_role_policy",
              values: { role: roleName, name: policyName, policy },
            }],
          },
        },
      }),
      stderr: "",
    }),
    parseOutputs: async () => ({
      execution_role_name: roleName,
      secret_reference_fingerprint_input: references,
    }),
  };
  const config = {
    get: (key: string, fallback?: unknown) => ({
      TERRAFORM_STATE_BUCKET: "fixture-state",
      TERRAFORM_STATE_REGION: "us-east-1",
    } as Record<string, unknown>)[key] ?? fallback,
  };
  const dataSource = {
    getRepository: () => ({
      findOneBy: async () => parent,
    }),
  };
  const service = new V1InfrastructureManifestApplyService(
    dataSource as never,
    config as never,
    terraform as never,
    {} as never,
  ) as any;

  await service.verifyArtifactAndPlan(manifest, workspace, planHash);
  showJson = show(JSON.stringify({
    Statement: [{ Effect: "Allow", Action: ["*"], Resource: references }],
  }));
  await assert.rejects(
    () => service.verifyArtifactAndPlan(manifest, workspace, planHash),
    /CANARY_APPLY_PLAN_CHANGED/,
  );
  showJson = show(policy, [{
    address: "aws_iam_role.unrelated",
    type: "aws_iam_role",
    mode: "managed",
    change: { actions: ["create"], after: {} },
  }]);
  await assert.rejects(
    () => service.verifyArtifactAndPlan(manifest, workspace, planHash),
    /CANARY_APPLY_PLAN_CHANGED/,
  );

  service.awsJson = async (args: string[]) => args[0] === "iam"
    ? { RoleName: roleName, PolicyName: policyName, PolicyDocument: JSON.parse(policy) }
    : { VersionId: "fixture-state-version" };
  service.objectExists = async () => false;
  const evidence = await service.collectVerifiedEvidence(manifest, workspace);
  assert.equal(evidence.stateVersionId, "fixture-state-version");
  assert.equal(evidence.resourceCount, 57);
  assert.equal(evidence.outputs.runtime_secret_access_policy_name, policyName);
  assert.equal(evidence.outputs.runtime_secret_access_reference_fingerprint, canonicalSha256(references));
  assert.equal("secret_reference_fingerprint_input" in evidence.outputs, false);
  assert.equal(evidence.outputs.ecs_cluster_arn, "fixture-cluster");
  process.stdout.write("V1 IAM secret-access saved-plan apply verification passed\n");
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
