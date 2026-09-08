export function grafanaDashboardUrl(baseUrl, projectId, service) {
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    if (projectId) url.searchParams.set("var-project", projectId);
    if (service) url.searchParams.set("var-service", service);
    return url.toString();
  } catch {
    return baseUrl;
  }
}
