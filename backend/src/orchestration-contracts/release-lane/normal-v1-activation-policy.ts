const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NormalV1OperatingMode = "canary" | "shared";

type ConfigurationReader = {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
};

export type NormalV1ActivationDecision = Readonly<{
  mode: NormalV1OperatingMode;
  environmentNames: readonly ["dev"];
  projectIds: readonly string[];
}>;

/**
 * One policy boundary for HTTP commands and independently supervised workers.
 * Shared mode deliberately has no project allowlist: project authorization is
 * revalidated from the durable intent before ownership is acquired. Canary
 * mode retains the historical one-project/dev harness.
 */
export function normalV1Activation(
  config: ConfigurationReader,
): NormalV1ActivationDecision | null {
  const explicitMode = config.get<unknown>("TWO_LANE_NORMAL_V1_OPERATING_MODE");
  const compositionMode = config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE");
  const mode = explicitMode === "shared" || compositionMode === "production_shared"
    ? "shared"
    : explicitMode === "canary" || compositionMode === "production_canary"
        || compositionMode === "fixture"
      ? "canary"
      : explicitMode === undefined && compositionMode === undefined
        ? "canary"
        : null;
  if (!mode) return null;

  const environments = parseList(
    config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST"),
  );
  if (environments.length !== 1 || environments[0] !== "dev") return null;

  if (mode === "shared") {
    return Object.freeze({
      mode,
      environmentNames: Object.freeze(["dev"] as ["dev"]),
      projectIds: Object.freeze([]),
    });
  }

  const projects = parseList(
    config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST"),
  );
  if (projects.length !== 1 || !UUID.test(projects[0])) return null;
  return Object.freeze({
    mode,
    environmentNames: Object.freeze(["dev"] as ["dev"]),
    projectIds: Object.freeze(projects),
  });
}

export function normalV1AllowsScope(
  config: ConfigurationReader,
  projectId: string,
  environmentName: string,
) {
  const activation = normalV1Activation(config);
  return Boolean(
    activation
    && UUID.test(projectId)
    && environmentName === "dev"
    && (
      activation.mode === "shared"
      || activation.projectIds[0] === projectId
    ),
  );
}

export function normalV1IsShared(config: ConfigurationReader) {
  return normalV1Activation(config)?.mode === "shared";
}

function parseList(value: unknown) {
  if (typeof value !== "string") return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(entries)].sort();
}
