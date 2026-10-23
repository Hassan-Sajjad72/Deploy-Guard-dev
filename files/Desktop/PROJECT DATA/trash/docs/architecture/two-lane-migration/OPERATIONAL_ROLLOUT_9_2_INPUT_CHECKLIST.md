# Operational Rollout 9.2 — Controlled AWS Preflight Input Checklist

## Purpose and boundary

This checklist prepares exactly one approved project in `dev` for the explicit,
read-only production-canary preflight. It does not enable a consumer or deploy
anything. The runner validates every listed input before creating a Nest
application or AWS client. It invokes only
`ProductionV1ReleaseCanaryPreflightService` and writes no data.

Run it only from `backend/`:

```bash
npm run preflight:operational-production-canary
```

It prints only one sanitized JSON result. Exit `0` means `ready`; exit `2` is
invalid/missing configuration; exit `3` is an AWS, manifest, tag, resource, or
permission blocker; exit `4` is a sanitized local runtime failure. It does not
start a listener, consumer, queue job, ownership claim, operation lease, or
handler.

## Exact variables and current local status

Never commit the actual values. The current `backend/.env` has no entry for
any variable below, so each is **missing**. `backend/.env.example` intentionally
contains defaults/placeholders only; they are **unverifiable** as canary inputs.

| Variable | Exact required value | Source | Local status |
| --- | --- | --- | --- |
| `TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED` | `true` | DeployGuard operator gate | Missing |
| `TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED` | `true` | DeployGuard operator gate | Missing |
| `TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED` | `true` | DeployGuard operator gate | Missing |
| `TWO_LANE_RELEASE_COMPOSITION_ENABLED` | `true` | DeployGuard operator gate | Missing |
| `TWO_LANE_RELEASE_COMPOSITION_MODE` | `production_canary` | DeployGuard operator gate | Missing |
| `TWO_LANE_RELEASE_WORKER_ID` | one valid opaque worker id | Operator-controlled, non-secret | Missing |
| `TWO_LANE_RELEASE_PROJECT_ALLOWLIST` | one approved project UUID | DeployGuard | Missing |
| `TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST` | `dev` | DeployGuard fixed compatibility scope | Missing |
| `TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST` | exactly the same one project UUID | DeployGuard | Missing |
| `TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST` | `dev` | DeployGuard fixed compatibility scope | Missing |
| `TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED` | `true` | DeployGuard operator gate | Missing |
| `TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE` | `read_only` | DeployGuard operator gate | Missing |
| `AWS_REGION` | the existing resource region | AWS/operator configuration | Present but **unverifiable** for a canary until resource identity is supplied |
| `TWO_LANE_CANARY_ECR_REPOSITORY` | exact existing repository name | AWS | Missing |
| `TWO_LANE_CANARY_ECS_CLUSTER` | exact existing cluster ARN or name | AWS | Missing |
| `TWO_LANE_CANARY_ECS_SERVICE` | exact existing long-lived service ARN or name | AWS | Missing |
| `TWO_LANE_CANARY_TARGET_GROUP` | exact existing target-group ARN | AWS | Missing |
| `TWO_LANE_CANARY_IAM_PRINCIPAL_ARN` | role ARN used by the AWS IAM simulator | AWS/operator configuration | Missing |

Credentials are intentionally absent from this table. The AWS SDK and CLI use
the existing operator credential chain; no access key, token, or secret should
be copied into this checklist or committed to `.env.example`.

## Obtain and verify values without selection

An operator must choose the project first. Do not use these steps to search for
or select an arbitrary resource.

### From DeployGuard

1. **Project UUID:** copy the UUID from the approved project's URL/API record
   or the `projects.id` value in the controlled local database. Use that exact
   value in both project allowlists.
2. **Applied InfrastructureManifest:** for that known UUID only, inspect
   `infrastructure_manifests` for `environment_name = 'dev'` and
   `status = 'applied'`. Record only that it exists; do not backfill or change
   it. Its `id` and `revision` are the infrastructure identity.
3. **Matching ReleaseManifest:** inspect `release_manifests` for the same
   project and `dev`, with `infrastructure_manifest_id` equal to that applied
   manifest. The selected row must contain immutable `image_uri`/`image_digest`
   and the expected task-definition identity. Its `id` and `revision` are the
   release identity.

Use this read-only query only after the operator supplies the project UUID:

```sql
SELECT i.id AS infrastructure_manifest_id, i.revision AS infrastructure_revision,
       r.id AS release_manifest_id, r.revision AS release_revision,
       r.status AS release_status
FROM infrastructure_manifests i
JOIN release_manifests r ON r.infrastructure_manifest_id = i.id
WHERE i.project_id = '<approved-project-uuid>'
  AND i.environment_name = 'dev'
  AND i.status = 'applied'
  AND r.project_id = i.project_id
  AND r.environment_name = 'dev'
ORDER BY r.revision DESC;
```

No matching row is an honest `CANARY_MANIFEST_IDENTITY_MISSING` prerequisite;
do not create one for this preflight.

### From the approved AWS resource set

With the approved project and its existing applied outputs in hand, copy—not
discover—the exact existing values for the same region:

1. region: `AWS_REGION`;
2. ECR repository that exactly matches the ReleaseManifest immutable image URI;
3. long-lived ECS cluster and service that currently use the matching release
   task definition;
4. target group attached to that service/load balancer; and
5. the IAM role ARN representing the future release mutation principal.

The preflight itself confirms these using only `DescribeRepositories`,
`DescribeClusters`, `DescribeServices`, `DescribeTaskDefinition`,
`DescribeTargetGroups`, and `iam simulate-principal-policy`. It also requires
the task-definition evidence tags for the project, environment, release and
infrastructure manifest IDs/revisions, task-definition input hash, and image
digest. Missing, duplicate, untagged, or mismatched evidence blocks safely.

## Controlled invocation sequence

1. In a private operator environment, set the exact values above. Do not add
   them to a committed file.
2. Confirm the selected scope is one UUID and `dev` in both allowlist pairs.
3. From `backend/`, run the one command above.
4. Preserve only its sanitized `state` and `safeCodes` in rollout notes.
5. If blocked, repair only the indicated existing manifest/tag/resource or
   permission prerequisite. Do not create cloud infrastructure as part of this
   rollout.

Current outcome: **BLOCKED — no configured project/resource set exists in the
local environment. AWS was not contacted.**
