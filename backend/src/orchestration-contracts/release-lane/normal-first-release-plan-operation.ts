import { FindOptionsWhere, In } from "typeorm";
import { DeploymentIntentStatus } from "../contracts/deployment-intent.types";
import { DeploymentIntent } from "../entities/deployment-intent.entity";

/**
 * Canonical identity for the first-release infrastructure-plan operation.
 * A retry is a new immutable operation, not a revival of the failed deploy
 * attempt, and therefore belongs to the same active planning lane.
 */
export const NORMAL_FIRST_RELEASE_PLAN_KINDS = ["deploy", "retry"] as const;
export const NORMAL_FIRST_RELEASE_PLAN_ACTIVE_STATUSES = [
  "planned",
  "enqueued",
  "running",
] as const satisfies readonly DeploymentIntentStatus[];

export function normalFirstReleasePlanOperationWhere(
  projectId: string,
  statuses: readonly DeploymentIntentStatus[] = NORMAL_FIRST_RELEASE_PLAN_ACTIVE_STATUSES,
): FindOptionsWhere<DeploymentIntent> {
  return {
    projectId,
    environmentName: "dev",
    kind: In([...NORMAL_FIRST_RELEASE_PLAN_KINDS]),
    classification: "infrastructure_change",
    status: In([...statuses]),
  };
}

export function isNormalFirstReleasePlanOperation(
  intent: Pick<DeploymentIntent, "kind" | "classification" | "environmentName">,
) {
  return intent.environmentName === "dev"
    && intent.classification === "infrastructure_change"
    && NORMAL_FIRST_RELEASE_PLAN_KINDS.includes(
      intent.kind as typeof NORMAL_FIRST_RELEASE_PLAN_KINDS[number],
    );
}
