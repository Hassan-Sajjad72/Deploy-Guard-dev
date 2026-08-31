export type ApplicationEntrypointService = {
  id?: string | null;
  serviceId?: string | null;
  publicUrl?: unknown;
};

function serviceIdentity(service: ApplicationEntrypointService) {
  return String(service.serviceId || service.id || "");
}

export function resolveApplicationEntrypointServiceId(
  configuredServiceId: string | null | undefined,
  services: ApplicationEntrypointService[],
) {
  const configured = String(configuredServiceId || "");
  if (configured) {
    return services.some((service) => serviceIdentity(service) === configured) ? configured : null;
  }
  return services.length === 1 ? serviceIdentity(services[0]) || null : null;
}

export function requireApplicationEntrypointServiceId(
  configuredServiceId: string | null | undefined,
  services: ApplicationEntrypointService[],
) {
  const resolved = resolveApplicationEntrypointServiceId(configuredServiceId, services);
  if (resolved) return resolved;
  if (configuredServiceId) throw new Error("The configured application service does not belong to the complete service set.");
  throw new Error("Select an application service before deploying this multi-service project.");
}

export function resolveProjectApplicationUrl(
  configuredServiceId: string | null | undefined,
  services: ApplicationEntrypointService[],
  legacyDeployedUrl: string | null = null,
) {
  const serviceId = resolveApplicationEntrypointServiceId(configuredServiceId, services);
  if (!serviceId) return configuredServiceId ? null : legacyDeployedUrl;
  const selected = services.find((service) => serviceIdentity(service) === serviceId);
  return selected && typeof selected.publicUrl === "string" && /^https?:\/\//i.test(selected.publicUrl)
    ? selected.publicUrl
    : null;
}
