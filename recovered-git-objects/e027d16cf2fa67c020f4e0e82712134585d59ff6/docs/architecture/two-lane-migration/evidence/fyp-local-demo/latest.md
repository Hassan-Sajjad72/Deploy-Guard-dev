# DeployGuard local FYP demonstration evidence

- Result: **passed**
- Evidence classification: **local runtime** with an **isolated non-cloud external executor**
- Live AWS: **not used**
- Disposable scope: `disposable/dev`
- Operation: `117f4624-d0b5-4d2e-842d-c09229e0d55c`
- BullMQ job: `dg:v1:release:117f4624-d0b5-4d2e-842d-c09229e0d55c:execute:1`
- Worker: `NORMAL_V1_RELEASE_CONSUMER_READY`
- Canonical state: `completed`
- Overview: Analyze/Build/Prepare/Deploy/Verify=passed; result=Live
- Cross-page refresh: overview=pipeline=dashboard=plan-usage:release-completed/stable
- Durable evidence: outbox-publications=1; provenance=1; effects=3; leases=0; owners=0; claims=0
- Cleanup: **complete**

## Walkthrough

1. Start disposable PostgreSQL and Redis only when absent.
2. Start the authenticated backend, Vite frontend and independently supervised normal-v1 worker.
3. Use the Overview Start deployment action; observe one prepare and one exact dispatch request.
4. Observe Analyze, Build, Prepare, Deploy and Verify through canonical current-state.
5. Refresh Overview, Pipeline, Dashboard and Plan & Usage and confirm one completed/stable release.
6. Stop through SIGTERM and verify the disposable database, isolated Redis keys, processes and temporary files are removed.

This is local/non-cloud evidence. It does not claim Docker build, ECR, ECS, Terraform or live AWS execution.
