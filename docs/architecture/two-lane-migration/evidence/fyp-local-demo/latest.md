# DeployGuard local FYP demonstration evidence

> Historical evidence only. This retired normal-v1/BullMQ procedure is not a supported command or startup path. The supported product uses `npm run product:start` and GitHub Actions exclusively.

- Result: **passed**
- Evidence classification: **local runtime** with an **isolated non-cloud external executor**
- Live AWS: **not used**
- Disposable scope: `disposable/dev`
- Operation: `68b6685d-62b3-4d46-a300-5ea00fa849ba`
- BullMQ job: `dg:v1:release:68b6685d-62b3-4d46-a300-5ea00fa849ba:execute:1`
- Worker: `NORMAL_V1_RELEASE_CONSUMER_READY`
- Canonical state: `completed`
- Overview: Analyze/Build/Prepare/Deploy/Verify=passed; result=Live
- Cross-page refresh: overview=pipeline=dashboard=plan-usage:release-completed/stable
- Durable evidence: outbox-publications=1; provenance=1; effects=3; leases=0; owners=0; claims=0
- Cleanup: **complete**
- Deferred providers: **Stripe off; SNS off**

## Historical walkthrough (retired; do not execute)

1. Start disposable PostgreSQL and Redis only when absent.
2. Start the authenticated backend, Vite frontend and independently supervised normal-v1 worker.
3. Use the Overview Deploy action; observe one canonical deployment command whose backend performs exact preparation and dispatch.
4. Observe Analyze, Build, Prepare, Deploy and Verify through canonical current-state.
5. Refresh Overview, Pipeline, Dashboard and Plan & Usage and confirm one completed/stable release.
6. Stop through SIGTERM and verify the disposable database, isolated Redis keys, processes and temporary files are removed.

This is local/non-cloud evidence. It does not claim Docker build, ECR, ECS, Terraform or live AWS execution.
