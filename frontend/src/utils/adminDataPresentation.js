const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

export function classifyAdminFailure(error, { ownerScoped = false } = {}) {
  const status = Number(error?.status) || null;
  const code = error?.code ? String(error.code) : null;
  const providerMessage = error?.message ? String(error.message) : "Request failed.";
  const ownerRestricted = ownerScoped
    && status === 403
    && /project.+(?:owner|ownership)|(?:owner|ownership).+project/i.test(providerMessage);
  const retryable = status === null || TRANSIENT_HTTP_STATUSES.has(status) || status >= 500;

  return {
    code,
    kind: ownerRestricted ? "owner-restriction" : retryable ? "transient" : "deterministic",
    message: ownerRestricted
      ? "Administrative access does not grant ownership of individual project operations."
      : providerMessage,
    providerMessage,
    retryable,
    status,
    title: ownerRestricted ? "Project operation evidence unavailable" : null,
  };
}

export async function loadIndependentAdminSources(loaders) {
  const names = Object.keys(loaders);
  const settled = await Promise.allSettled(names.map((name) => loaders[name]()));

  return Object.fromEntries(settled.map((result, index) => [names[index], result]));
}
