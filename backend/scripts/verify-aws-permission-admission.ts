import "reflect-metadata";
import { strict as assert } from "node:assert";
import { SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { WORKFLOW_AWS_CAPABILITIES, WorkflowAwsCapabilityScope } from "../src/projects/github-actions-aws-capability-contract";
import { assertAwsAccountConsistency, AwsAccountConfigurationError, reconcileWorkflowCapabilities, verifyEffectiveWorkflowCapabilities, WorkflowAwsCapabilityError } from "../src/projects/github-actions-aws-capability.service";

const scope: WorkflowAwsCapabilityScope = { accountId: "123456789012", region: "us-east-1",
  projectId: "11111111-1111-4111-8111-111111111111", environmentName: "dev",
  generationId: "22222222-2222-4222-8222-222222222222", terraformStateBucket: "s02-local-state",
  vpcId: "vpc-00000000000000000", managedDatabaseEnabled: false };
const roleArn = `arn:aws:iam::${scope.accountId}:role/deployguard`;
const state = WORKFLOW_AWS_CAPABILITIES.find((row) => row.id === "terraform-state")!;
const capabilities = [state];
const allowed = (input: any) => ({ EvaluationResults: input.ActionNames.map((action: string) => ({
  EvalActionName: action, EvalDecision: "allowed", ResourceSpecificResults: input.ResourceArns.map((resource: string) => ({
    EvalResourceName: resource, EvalResourceDecision: "allowed" })) })) });

async function verify() {
  assert.throws(() => assertAwsAccountConsistency(scope.accountId, scope.accountId, ""), AwsAccountConfigurationError,
    "a supplied but missing STS caller account cannot be treated as verified identity");
  await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async () => ({ EvaluationResults: [] }) },
    roleArn, scope, "deploy", capabilities), WorkflowAwsCapabilityError,
  "empty IAM response cannot certify a usable AWS connection");
  const calls: any[] = [];
  const client = { send: async (command: any) => { assert.ok(command instanceof SimulatePrincipalPolicyCommand);
    assert.equal(command.input.MaxItems, 1000);
    calls.push(structuredClone(command.input)); return allowed(command.input); } };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(client, roleArn, scope, "deploy", capabilities), []);
  assert.ok(calls.every((input) => input.PolicySourceArn === roleArn));
  assert.ok(calls.some((input) => input.ResourceArns.includes(`arn:aws:s3:::${scope.terraformStateBucket}/projects/${scope.projectId}/dev/runtime/terraform.tfstate.tflock`)));
  for (const mutate of [
    (response: any) => { delete response.EvaluationResults; },
    (response: any) => { response.EvaluationResults.pop(); },
    (response: any) => { response.EvaluationResults.push(response.EvaluationResults[0]); },
    (response: any) => { response.EvaluationResults[0].EvalActionName = "iam:DeleteRole"; },
    (response: any) => { response.EvaluationResults[0].EvalDecision = "unknown"; },
    (response: any) => { response.EvaluationResults[0].ResourceSpecificResults.pop(); },
    (response: any) => { response.EvaluationResults[0].ResourceSpecificResults[0].EvalResourceName = "arn:aws:s3:::another-client"; },
    (response: any) => { response.EvaluationResults[0].ResourceSpecificResults.push(response.EvaluationResults[0].ResourceSpecificResults[0]); },
    (response: any) => { response.IsTruncated = true; },
    (response: any) => { response.IsTruncated = "false"; },
  ]) {
    await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async (command: any) => {
      const response: any = allowed(command.input); mutate(response); return response;
    } }, roleArn, scope, "deploy", capabilities), WorkflowAwsCapabilityError);
  }
  for (const field of ["MissingContextValues", "PermissionsBoundaryDecisionDetail", "OrganizationsDecisionDetail", "EvalDecisionDetails", "resourceDeny", "resourceContext", "resourceBoundary"] as const) {
    const denied = await verifyEffectiveWorkflowCapabilities({ send: async (command: any) => {
      const response: any = allowed(command.input);
      for (const row of response.EvaluationResults) {
        if (field === "MissingContextValues") row.MissingContextValues = ["aws:PrincipalTag/client"];
        if (field === "PermissionsBoundaryDecisionDetail") row.PermissionsBoundaryDecisionDetail = { AllowedByPermissionsBoundary: false };
        if (field === "OrganizationsDecisionDetail") row.OrganizationsDecisionDetail = { AllowedByOrganizations: false };
        if (field === "EvalDecisionDetails") row.EvalDecisionDetails = { resourcePolicy: "implicitDeny" };
        if (field === "resourceDeny") row.ResourceSpecificResults[0].EvalResourceDecision = "explicitDeny";
        if (field === "resourceContext") row.ResourceSpecificResults[0].MissingContextValues = ["aws:ResourceTag/client"];
        if (field === "resourceBoundary") row.ResourceSpecificResults[0].PermissionsBoundaryDecisionDetail = { AllowedByPermissionsBoundary: false };
      }
      return response;
    } }, roleArn, scope, "deploy", capabilities);
    assert.deepEqual(denied, [...state.actions].sort(), `${field} cannot be overridden by an aggregate allow`);
  }
  const aborted = new AbortController(); aborted.abort(); let afterAbortCalls = 0;
  await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async () => { afterAbortCalls++; return {}; } },
    roleArn, scope, "deploy", capabilities, aborted.signal), WorkflowAwsCapabilityError);
  assert.equal(afterAbortCalls, 0);
  let paginatedCalls = 0;
  const paginated = { send: async (command: any) => {
    paginatedCalls++; const response = allowed(command.input);
    if (!command.input.Marker) return { EvaluationResults: response.EvaluationResults.slice(0, 1), IsTruncated: true, Marker: "next" };
    assert.equal(command.input.Marker, "next");
    return { EvaluationResults: response.EvaluationResults.slice(1), IsTruncated: false };
  } };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(paginated, roleArn, scope, "deploy", capabilities), []);
  assert.equal(paginatedCalls, 4, "both state action/resource groups consume complete paginated evidence");
  let pages = 0;
  await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async () => {
    pages++; return { EvaluationResults: [], IsTruncated: true, Marker: "repeated" };
  } }, roleArn, scope, "deploy", capabilities), WorkflowAwsCapabilityError);
  assert.equal(pages, 2, "repeated continuation token must stop bounded pagination");
  pages = 0;
  await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async () => ({
    EvaluationResults: [], IsTruncated: true, Marker: `page-${++pages}`,
  }) }, roleArn, scope, "deploy", capabilities), WorkflowAwsCapabilityError);
  assert.equal(pages, 20, "unique but endless continuations cannot escape the page budget");
  let policyWrites = 0;
  await assert.rejects(() => reconcileWorkflowCapabilities({ client: { send: async (command: any) => {
    if (command.constructor.name === "GetRolePolicyCommand") return {};
    if (command instanceof SimulatePrincipalPolicyCommand) return { EvaluationResults: [] };
    policyWrites++; throw new Error("unexpected mutation");
  } }, roleArn, roleName: "deployguard", scope, action: "deploy", platformManaged: false, capabilities }), WorkflowAwsCapabilityError);
  assert.equal(policyWrites, 0, "externally managed customer permissions are never auto-expanded");
  await assert.rejects(() => verifyEffectiveWorkflowCapabilities({ send: async () => { throw new Error("DO-NOT-LEAK-CREDENTIAL"); } },
    roleArn, scope, "deploy", capabilities), (error: any) => {
      assert.ok(error instanceof WorkflowAwsCapabilityError); assert.doesNotMatch(JSON.stringify(error.getResponse()), /DO-NOT-LEAK/); return true;
    });
  console.log("AWS_PERMISSION_ADMISSION=PASS INCOMPLETE_FAIL_CLOSED=1 EXACT_SCOPE=1 POLICY_DENIALS=1 PAGINATION_BOUNDED=1 CUSTOMER_POLICY_WRITES=0 AWS_EXECUTION=NONE");
}
void verify().catch((error) => { console.error(error); process.exitCode = 1; });
