module.exports = {
  forbidden: [
    {
      name: "railpack-path-cannot-reach-retired-mutation-authority",
      severity: "error",
      comment: "Lifecycle mutations are owned by RailpackDeploymentService and must not reach retired mutation providers.",
      from: { path: "^src/projects/(railpack-deployment\.service|projects\.controller|project-deletion\.service)\.ts$" },
      to: { path: "^src/(projects/normal-deployment-command\.service\.ts|projects/pipeline/(pipeline\.service|pipeline-worker\.service|pipeline\.queue|pipeline-job-finality\.service)\.ts|orchestration/(orchestration|ecs|rollback)\.service\.ts|state-management/state-management\.service\.ts|storage/storage\.service\.ts)$" },
    },
    {
      name: "canonical-current-state-cannot-reach-retired-mutation-authority",
      severity: "error",
      comment: "Current-state and LIVE identity are readers of canonical generation authority, not retired mutation paths.",
      from: { path: "^src/projects/current-state/" },
      to: { path: "^src/(projects/normal-deployment-command\.service\.ts|projects/pipeline/(pipeline\.service|pipeline-worker\.service|pipeline\.queue|pipeline-job-finality\.service)\.ts|orchestration/(orchestration|ecs|rollback)\.service\.ts|state-management/state-management\.service\.ts|storage/storage\.service\.ts)$" },
    },
    {
      name: "observability-cannot-own-lifecycle-mutations",
      severity: "error",
      comment: "Observability consumes canonical LIVE identity and cannot import lifecycle mutation services.",
      from: { path: "^src/observability/" },
      to: { path: "^src/projects/(railpack-deployment|project-deletion)\.service\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|node_modules|scripts|migrations|.*\\.spec\\.ts)(/|$)",
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
