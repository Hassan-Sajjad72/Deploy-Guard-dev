# Railway local launch acceptance — Iteration 8

Date: 2026-08-01  
Result: **passed**  
Classification: **isolated and local runtime; live AWS not used**

## Acceptance matrix

- Three authenticated developer workspaces, two private projects each: passed.
- Cross-workspace project/environment denial and secret isolation: passed.
- Clean Express, clean Python and configuration-required detection: passed.
- Unchanged source `no_op`; changed source `release_only`: passed.
- Eight-way same-operation deduplication and different-project planning: passed.
- PostgreSQL advisory-lock serialization and BullMQ duplicate identity: passed.
- Supervised non-cloud managed first release: passed without a fabricated URL.
- Browser Overview Deploy command, exact queue consumption, five phases, Live,
  refresh, stable/latest and Dashboard/Deployments/Plan & Usage consistency:
  passed. Operation `6469e564-c4bc-4efd-8f86-5aa25b9a8bd2`; job
  `dg:v1:release:6469e564-c4bc-4efd-8f86-5aa25b9a8bd2:execute:1`.
- Shared release-worker restart: returned healthy and `ready=true`; both
  infrastructure workers remained healthy.
- Developer-page terminology and six-item project navigation: passed.
- Final active lease/owner/outbox-claim counts: `0/0/0`.

The signed browser/durable evidence is in the sibling `fyp-local-demo` evidence
directory. Stripe and SNS remained disabled. No Terraform, Docker image, ECR,
ECS, ALB or other AWS mutation was executed.
