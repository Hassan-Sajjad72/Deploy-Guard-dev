# Final local FYP demonstration

Run the complete safe demonstration from the repository root:

```bash
npm run demo:fyp-local
```

The command starts the existing disposable normal-v1 demo, waits for its
authenticated backend, frontend, PostgreSQL, isolated Redis/BullMQ queue and
independently supervised release worker, verifies the result twice through
the public status contract, and shuts everything down. It exercises one real
prepare request, one exact dispatch, one deterministic queue delivery,
fenced durable state, the canonical five release phases, and refresh-consistent
Overview, Pipeline, Dashboard and Plan & Usage projections.

Only the external release executor is a deterministic local fixture. The
fixture is test-only and cannot activate in production. Docker build/push,
Terraform, ECR, ECS and other AWS execution are not reachable, so this bundle
is local runtime and isolated non-cloud evidence—not live AWS evidence.

The self-verifying bundle is written to:

- `docs/architecture/two-lane-migration/evidence/fyp-local-demo/latest.json`
- `docs/architecture/two-lane-migration/evidence/fyp-local-demo/latest.md`
- `docs/architecture/two-lane-migration/evidence/fyp-local-demo/latest.sha256`

The JSON records the disposable scope, operation and deterministic job,
worker readiness, queue consumption, durable counts, rendered phase result,
cross-page state and cleanup assertions. It contains no credentials, internal
fences, leases, queue payloads or cloud identifiers. Verify a completed bundle
with:

```bash
cd backend
npm run test:final-fyp-local-demo
```

On success the runner sends graceful SIGTERM, removes the disposable database,
isolated Redis keys and temporary state/log files, restores the prior Compose
baseline and leaves all activation gates default-off. Normal-v1 deletion
execution remains intentionally unavailable and is outside this demo.
