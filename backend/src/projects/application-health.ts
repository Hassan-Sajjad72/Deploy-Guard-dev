export type ApplicationHealthStatus = "healthy" | "failed" | "unavailable";

export function applicationHealthFromHttpStatus(status: unknown): ApplicationHealthStatus {
  if (!Number.isInteger(status) || Number(status) < 200 || Number(status) > 599) return "unavailable";
  return Number(status) < 400 ? "healthy" : "failed";
}

export async function probeApplicationHealth(publicUrl: string | null) {
  // Only immutable AWS ALB origins are probed; redirects cannot authorize another host.
  if (!publicUrl || !/^https?:\/\/[a-z0-9-]+\.[a-z0-9-]+\.elb\.amazonaws\.com\/?$/i.test(publicUrl)) {
    return { status: "unavailable" as ApplicationHealthStatus, httpStatus: null };
  }
  try {
    const response = await fetch(publicUrl, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return { status: applicationHealthFromHttpStatus(response.status), httpStatus: response.status };
  } catch {
    return { status: "unavailable" as ApplicationHealthStatus, httpStatus: null };
  }
}
