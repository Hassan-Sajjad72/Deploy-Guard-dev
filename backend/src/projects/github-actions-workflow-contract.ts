import {
  RAILPACK_WORKFLOW_CONTRACT_VERSION,
  RAILPACK_WORKFLOW_INPUTS,
} from "./railpack-workflow-contract";

export type PinnedReusableWorkflow = {
  owner: string;
  repository: string;
  path: string;
  sha: string;
  reference: string;
};

export class GithubActionsWorkflowContractError extends Error {
  constructor(public readonly detail: string) {
    super(`Reusable workflow contract mismatch: ${detail}`);
  }
}

export function parsePinnedReusableWorkflow(reference: string): PinnedReusableWorkflow {
  const match = reference.match(/^([^/]+)\/([^/]+)\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@([0-9a-f]{40})$/);
  if (!match) {
    throw new GithubActionsWorkflowContractError("configured reusable workflow must use an exact 40-character commit SHA.");
  }
  return { owner: match[1], repository: match[2], path: match[3], sha: match[4], reference };
}

export function reusableWorkflowInputDeclarations(workflow: string) {
  const block = workflow.match(/\n  workflow_call:\n    inputs:\n([\s\S]*?)\n\n(?:permissions|jobs):/)?.[1] || "";
  return [...block.matchAll(/^      ([a-z][a-z0-9_]*): \{ required: (true|false), type: (string|number|boolean)(?:, default: [^}]+)? \}$/gm)]
    .map((match) => ({ name: match[1], required: match[2] === "true", type: match[3] }));
}

export function generatedCallerWithKeys(workflow: string) {
  const block = workflow.match(/\n    with:\n([\s\S]*?)\n?$/)?.[1] || "";
  return [...block.matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((match) => match[1]);
}

export function assertReusableWorkflowCompatibility(workflow: string, pinned: PinnedReusableWorkflow, callerWithKeys?: readonly string[]) {
  const declared = reusableWorkflowInputDeclarations(workflow);
  const byName = new Map(declared.map((input) => [input.name, input]));
  for (const expected of RAILPACK_WORKFLOW_INPUTS) {
    const actual = byName.get(expected.name);
    if (!actual) throw new GithubActionsWorkflowContractError(`caller input \`${expected.name}\` is not declared by pinned workflow ${pinned.sha}.`);
    if (actual.required !== expected.required || actual.type !== expected.type) {
      throw new GithubActionsWorkflowContractError(`input \`${expected.name}\` in pinned workflow ${pinned.sha} must be ${expected.required ? "required" : "optional"} ${expected.type} for ${RAILPACK_WORKFLOW_CONTRACT_VERSION}.`);
    }
  }
  const expectedNames = new Set(RAILPACK_WORKFLOW_INPUTS.map((input) => input.name));
  const extra = declared.find((input) => !expectedNames.has(input.name as never));
  if (extra) throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} declares unknown input \`${extra.name}\`.`);
  if (callerWithKeys) {
    const caller = new Set(callerWithKeys);
    const extraCaller = callerWithKeys.find((name) => !expectedNames.has(name as never));
    if (extraCaller) throw new GithubActionsWorkflowContractError(`caller input \`${extraCaller}\` is not declared by pinned workflow ${pinned.sha}.`);
    const missing = RAILPACK_WORKFLOW_INPUTS.find((input) => input.required && !caller.has(input.name));
    if (missing) throw new GithubActionsWorkflowContractError(`caller is missing required pinned-workflow input \`${missing.name}\`.`);
  }
  return { contractVersion: RAILPACK_WORKFLOW_CONTRACT_VERSION, sha: pinned.sha, inputs: declared };
}
