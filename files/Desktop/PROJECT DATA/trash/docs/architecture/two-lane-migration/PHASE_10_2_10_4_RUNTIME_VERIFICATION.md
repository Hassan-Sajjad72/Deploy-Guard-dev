# Phase 10.2–10.4 Runtime Verification

Date: 2026-07-27

## Scope

Local-only verification of the existing Nest backend, PostgreSQL, Redis, and
frontend source path. No deployment, queue, Docker build, ECR/ECS, Terraform,
AWS mutation, or release execution was performed. No production code was
changed during this verification.

## Runtime setup

- PostgreSQL: Docker Compose `postgres`, mapped locally to `5433`.
- Redis: Docker Compose `redis`, mapped locally to `6379`.
- Backend: `npm run start:dev`, initialized successfully on `http://localhost:5000`.
- Ephemeral process configuration enabled the exact v1 planning allowlist for
  the fresh canary project `fc0d5f53-8b6d-401a-b532-966dd4f7eff8` and `dev`.
- Authentication used the existing local session-cookie mechanism; no secret
  or token was printed.

## Durable local evidence

The controlled database contains one fresh canary project and two relevant
release-only intents. The latest intent is terminal `completed`, linked to
candidate ReleaseManifest revision `3` and applied InfrastructureManifest
revision `4`; no prepared/pending intent currently exists. Therefore a
prepared-state-after-refresh claim cannot be made from this database snapshot.

## Observed requests

Authenticated developer session, Project-Tst canary:

`GET /api/projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/current-state`

returned HTTP 200 and the following sanitized projection:

```json
{
  "releaseLane": {
    "state": "completed",
    "safeCodes": ["RELEASE_LANE_INTENT_COMPLETED"],
    "intent": {
      "safeId": "400f679c",
      "status": "completed",
      "releaseManifestRevision": "3",
      "appliedInfrastructureRevision": "4",
      "outboxStatus": "pending",
      "sourceCommitShortSha": "1d1ab0dd6905",
      "lifecycleCode": "RELEASE_LANE_INTENT_COMPLETED"
    }
  },
  "activeRunCount": 0,
  "hasPipelineRun": false,
  "runControls": {"canCancel": false, "canRetry": false}
}
```

The same request also showed no legacy pipeline run and no active run, which
confirms the v1 projection is not being counted as a pipeline run.

## First reproducible blocker

Authenticated requests to:

`GET /api/projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/release-lane/status`

returned HTTP `401 Authentication required`, while `/auth/me` and the
current-state route accepted the same session cookie. Unauthenticated access
also returned 401. This proves the route is not receiving the normal auth
middleware, not that project authorization failed.

Evidence: `backend/src/app.module.ts` registers middleware for
`api/projects/:projectId/current-state`, but has no entry for
`api/projects/:projectId/release-lane/status` (nor the Phase 10.1 prepare
path). The controller route exists in `backend/src/projects/projects.controller.ts`.

Smallest proposed fix: add the status route to
`AuthenticatedUserMiddleware` registration, then rerun the authenticated
eligible/ineligible/cross-project checks. No fix was applied in this audit.

## Static/UI evidence

The current source confirms Project Details and Pipeline consume
`currentState.releaseLane` and do not issue a separate status request. The
existing UI checks also preserve legacy Start deployment fallback, Dashboard
`activeRunCount`, pipeline history, stable URL, and rollback controls.

## Result

**Blocked at the first runtime defect:** current-state projection is proven for
the completed local canary, but standalone status-route authentication and a
prepared-state refresh cannot be proven until the middleware registration is
corrected and a prepared local intent is available. Phase 10.5 was not
implemented.
