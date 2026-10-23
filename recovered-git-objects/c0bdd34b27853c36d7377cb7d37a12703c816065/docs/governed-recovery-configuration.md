# Governed recovery and repair configuration

Recovery requests bind a versioned runbook to a current verified incident, immutable source, exact release and resource identities, customer account binding and conservative monthly cost ceiling. An owner, administrator or approver must approve the request fingerprint. An engineer may prepare and execute the approved request. Membership and approving authority are checked again before mutation.

The registry includes immediate verified rollback, safe idempotent retry, one-service ECS restart and one-service replica adjustment between one and four. Attempts are bounded per incident and runbook; each project can have one running recovery. GET requests verify independently observed outcomes. The execution claim is retained before provider calls; an uncertain dispatch is not automatically repeated. Customer ECS mutation additionally requires verified account mutation authority, current IAM role access and matching project resource tags. Unverified authority, incomplete cost evidence and changed source or scope block execution.

Repair checks run asynchronously. Configure these server-owned values only after reviewing the sandbox image and test commands:

- `REPAIR_SANDBOX_IMAGE`: a locally available image pinned to its `@sha256:` digest. The worker never pulls an image automatically.
- `REPAIR_TEST_COMMAND_JSON`: a JSON array containing the executable and arguments for the relevant application regression test, such as `["node","tests/reproduced-defect.js"]`.
- `REPAIR_CONTRACT_TEST_COMMAND_JSON`: a JSON array for approved API contract tests inside the isolated sandbox. Its application and dependencies must be in the approved image or bounded source checkout; external network access is disabled.

The sandbox has no network access, production environment variables, Docker socket, host write mounts or additional capabilities. It uses a non-root user, read-only root filesystem, bounded temporary storage, 512 MiB memory, one CPU and 64 processes. Each test invocation has a five-minute timeout. Source credential files and Git metadata are excluded. Repository code runs only inside this sandbox. The unmodified exact-SHA source must first reproduce a failing test; the bounded patch then needs passing application and API contract tests. Missing isolation or incomplete checks remain UNVERIFIED.

Repair proposals replace at most ten existing tracked application files, up to 128 KiB total, and cannot change workflows, dependency manifests, secrets or IAM infrastructure. Publication requires a fresh human approver, passing fingerprint-matched checks, unchanged source branch and a repository-authorized GitHub App. Publication creates a draft pull request on a separate repair branch. It never merges, updates a protected branch or deploys. Operational recovery remains UNVERIFIED until independently observed through the approved deployment and recovery process.

Apply migration `1791676809000-GovernedRecovery` before starting the updated API. Recovery requests, decisions and repair proposal content are retained and protected against rewriting or deletion. Sandbox checks interrupted by process shutdown are marked UNVERIFIED after their deadline when the project evidence is next read; no mutation is replayed automatically.
