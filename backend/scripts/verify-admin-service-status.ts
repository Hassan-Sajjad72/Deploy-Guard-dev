import { strict as assert } from "node:assert";
import { probeGrafanaAvailability } from "../src/admin/admin.controller";

async function verify() {
  let requestedUrl = "";
  const healthy = await probeGrafanaAvailability(
    "http://localhost:3001/d/deployguard-runtime/deployguard-runtime",
    (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ database: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );
  assert.equal(requestedUrl, "http://localhost:3001/api/health");
  assert.deepEqual(healthy, { status: "available", source: "live_health_probe" });

  const degraded = await probeGrafanaAvailability(
    "http://localhost:3001/dashboard",
    (async () => new Response("unhealthy", { status: 503 })) as typeof fetch,
  );
  assert.deepEqual(degraded, { status: "degraded", source: "live_health_probe" });

  const unavailable = await probeGrafanaAvailability(
    "http://localhost:3001/dashboard",
    (async () => { throw new Error("connection refused"); }) as typeof fetch,
  );
  assert.deepEqual(unavailable, { status: "unavailable", source: "live_health_probe" });
  assert.deepEqual(await probeGrafanaAvailability(undefined), {
    status: "unavailable",
    source: "runtime_configuration",
  });

  console.log("Admin Grafana live availability projection verification passed.");
}

void verify();
