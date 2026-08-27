const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const API_BASE_URL = configuredApiBaseUrl === undefined
  ? "http://localhost:5000"
  : configuredApiBaseUrl.replace(/\/$/, "");

export async function apiRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(typeof window !== "undefined" && window.location?.pathname?.startsWith("/projects/")
      ? { "X-DeployGuard-Route": `${window.location.pathname}${window.location.search || ""}` }
      : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
    body:
      options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || "Request failed");
    error.status = response.status;
    error.code = payload?.code || null;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}
