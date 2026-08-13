# DeployGuard integrated deployment blockers

Verified on 2026-08-10 using the normal local DeployGuard API flow. No application or platform source files were changed during this verification.

## Blocking: generated caller and pinned reusable workflow have different input schemas

Platform owner: DeployGuard GitHub Actions integration

The fresh deployment was accepted by GitHub but ended as `startup_failure` before GitHub created a job. GitHub's workflow annotation gives the exact error:

> The workflow is not valid. .github/workflows/deployguard.yml (Line: 41, Col: 26): Invalid input, build_plan_base64 is not defined in the referenced workflow.

The generated caller passes `build_plan_base64` after unpacking `build_plan_contract_json`, but the reusable workflow pinned by that caller does not declare a `build_plan_base64` input. This caller/reusable schema-version mismatch occurs during GitHub workflow startup, before checkout, OIDC, or any AWS step can run.

Evidence:

- Project: `Hassan-Sajjad72/react-pomodoro`
- Branch: `master`
- Commit: `ed4e07d8a439045041ba89e8e51225436bffa66b`
- DeployGuard operation: `4b7d509f-573a-4d8d-a85a-612bd2a51f1a`
- GitHub run: `31359977772`
- Run URL: https://github.com/Hassan-Sajjad72/react-pomodoro/actions/runs/31359977772
- GitHub conclusion: `startup_failure`
- GitHub annotation: `Invalid input, build_plan_base64 is not defined in the referenced workflow.`
- Jobs created: `0`
- GitHub logs: unavailable (`404`) because no job started
- Caller workflow: `.github/workflows/deployguard.yml`
- Reusable workflow: `Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@97a1a7e7bb258f8ace634315414b96c419681cc8`
- DeployGuard persisted the operation as failed at stage `github_actions` with no failed-job log.

Required platform correction: publish a reusable workflow revision that declares the canonical BuildPlan input contract, update the configured immutable reusable-workflow pin to that compatible revision, and validate generated caller inputs against the exact pinned reusable workflow before updating customer repositories or dispatching.

## Integrated-flow defect: Deploy can reject a stale contract instead of refreshing it

The first normal `POST /api/projects/:id/deploy` returned HTTP 400 `stale_commit`. The stored detection contract referenced `0703b60a6eefc9ad3fa111e5636b2a282f052db9`, while remote `master` was `ed4e07d8a439045041ba89e8e51225436bffa66b`. An explicit Detect Stack request refreshed the profile and contract, after which Deploy dispatched successfully.

This means an operator can still encounter a stale-contract blocker in the integrated Deploy action and must explicitly rerun Detect Stack before deployment proceeds.

## Deployment result

The tested deployment did not reach application build or AWS authentication. No job was created and this attempt made no AWS infrastructure changes. The product remains blocked for integrated operator deployment until the caller/reusable input schema is corrected.
