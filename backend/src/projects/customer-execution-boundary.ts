import { ServiceUnavailableException } from "@nestjs/common";
import { Project } from "./project.entity";

export function assertLegacyExecutionScope(project: Pick<Project, "id" | "organizationId" | "executionMode">) {
  if (project.executionMode === "customer" || (project.organizationId && project.executionMode !== "legacy_control_plane")) {
    throw new ServiceUnavailableException({ code: "CUSTOMER_EXECUTION_UNAVAILABLE",
      message: "Customer deployment requires an approved plan and verified account-scoped execution. The legacy AWS workflow cannot execute this project.",
      planningRoute: `/projects/${project.id}/planning` });
  }
}
