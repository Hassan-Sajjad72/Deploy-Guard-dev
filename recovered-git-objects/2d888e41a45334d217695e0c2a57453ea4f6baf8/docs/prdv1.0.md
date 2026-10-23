# DeployGuard — Product Requirements Specification v1.1

**Document:** Product Requirements Document (PRD)  
**Version:** 1.1  
**Date:** 10 October 2026  
**Status:** Proposed for formal founder approval  
**Industry:** Software / IT — AI-Enabled Cloud Deployment & Operations  
**Business Model:** AWS-first B2B SaaS  
**Primary Customers:** Startups and small-to-medium software development teams  
**Secondary Customers:** Software agencies, AWS consultancies and DevOps service providers

**Supersedes:** PRD v1.0 upon approval. All FR-001–FR-198 identifiers remain preserved.

---

## 1. Product Definition

DeployGuard is an intelligent AWS deployment and operations platform that enables software teams to analyze application requirements, plan infrastructure, deploy applications, monitor operations, understand costs and perform safe recovery through one unified control plane.

The core differentiator is the **Intelligence Harness**, which combines repository analysis, build requirements, configuration intelligence, AWS infrastructure capabilities, security findings, pricing data and operational evidence.

Natural-language prompts provide a simplified way to interact with the system. However, all infrastructure actions must pass deterministic validation, authorization and approval.

### Core product workflow

Connect GitHub → Analyze Application → Gather Missing Requirements → Generate Infrastructure Plan → Review Costs and Security → Approve → Deploy → Verify → Monitor → Recover or Delete.

A startup or development team shall complete this workflow **without creating a client or engagement record**.

Software agencies shall use the same workflow, with additional client organization, account separation and handoff capabilities.

### Product positioning

DeployGuard helps startups, software teams and agencies deploy and operate applications on AWS with intelligent planning, transparent infrastructure decisions and verified operational control.

---

## 2. Problem Statement

Cloud application deployment requires coordination across multiple systems, including source repositories, runtime analysis, environment configuration, container builds, CI/CD workflows, infrastructure provisioning, security scanning, monitoring and cost estimation.

Small software teams often lack dedicated platform engineering resources and must manage these tasks themselves.

Software agencies face additional overhead from repeatedly delivering applications to different client environments.

The central challenges include:

- Repetitive cloud configuration.
- Unclear application and infrastructure requirements.
- Fragmented deployment and operational tools.
- Unpredictable or poorly understood AWS costs.
- Difficult troubleshooting and recovery.
- Insufficient evidence of successful deployments.
- Complex management of application resources and ownership.

DeployGuard shall reduce this overhead by providing a structured, intelligent and verifiable application delivery process.

---

## 3. Target Customers

### Primary market

**Startups and small-to-medium software development teams**

Customers who want to deploy applications on AWS without building and maintaining a complete internal developer platform.

Typical users include startup founders with technical teams, backend developers, full-stack developers and DevOps engineers.

### Secondary market

**Software agencies and AWS/DevOps consultancies**

Organizations delivering and maintaining applications for multiple external clients.

### User roles

- Organization Owner
- Administrator
- Engineer
- Deployment Approver
- Read-only Viewer
- Internal DeployGuard Platform Operator

### Customer requirements

Customers must have an authorized AWS account or be prepared to create one through AWS's standard onboarding process.

DeployGuard shall not represent AWS infrastructure as free or account-free.

---

## 4. Product Release Boundaries

### R1 — Intelligent AWS Application Delivery

R1 shall deliver the complete supported application delivery lifecycle.

Required capabilities:

- Startup/team onboarding.
- GitHub authentication and repository connection.
- AWS account binding.
- Project and environment management.
- Intelligence Harness.
- Configuration and dependency analysis.
- Validated Deployment Plans.
- Prompt-to-plan interaction.
- Cost and security review.
- AWS ECS Fargate deployment.
- Certified static hosting through S3 and CloudFront.
- Deployment verification.
- Monitoring and release history.
- Verified rollback and safe cleanup.
- Operational evidence export.
- Essential authorization and administration.
- Agency client management and handoff as an extended workflow.

R1 must provide a functioning end-to-end experience rather than disconnected prototypes.

### R2 — Commercial SaaS and Operational Intelligence

R2 shall provide:

- Subscription and entitlement management.
- B2B invoices and payment reconciliation.
- Extended platform administration.
- Usage metering.
- API reliability assurance.
- Incident investigation.
- Evidence-based cloud optimization.

### R3 — Governed Recovery and Supervised Repair

R3 shall provide:

- Approved operational recovery runbooks.
- Policy-controlled remediation.
- Bounded automated recovery.
- Post-action verification.
- Sandboxed application code-repair proposals.
- GitHub pull-request-based repair workflows.

Unrestricted autonomous changes to production infrastructure or application code are excluded.

---

## 5. Fixed Technology Architecture

| Component | Technology |
|---|---|
| Frontend | React and TypeScript |
| Core Backend | NestJS and TypeScript |
| Database | PostgreSQL |
| Authentication | GitHub OAuth |
| Repository Provider | GitHub |
| CI/CD | GitHub Actions |
| Build System | Pinned Railpack and validated Dockerfile support |
| Infrastructure as Code | Terraform |
| Container Hosting | AWS ECS Fargate |
| Container Registry | Amazon ECR |
| Static Hosting | Private S3 and CloudFront |
| Object Storage | Amazon S3 |
| Monitoring | Amazon CloudWatch |
| Vulnerability Scanning | Trivy |
| Cost Estimation | Infracost and AWS pricing sources |
| AI Interface | Backend-controlled Amazon Bedrock adapter |
| AWS Authorization | Temporary IAM roles and GitHub OIDC |
| Initial Certified Region | us-east-1 |

### Architectural restrictions

- Retain the existing modular NestJS monolith.
- Do not migrate to microservices.
- Do not replace NestJS with Firebase or Supabase.
- Do not introduce Kubernetes in R1–R3.
- Do not add multi-cloud support.
- Do not train a custom foundation model.
- Do not let an LLM directly execute arbitrary AWS commands.
- Do not introduce a second infrastructure orchestration engine.
- Reuse existing infrastructure and deployment components wherever possible.

---

## 6. Domain Model and Ownership

The platform shall maintain these core entities:

**User, Organization, Membership, Project, Environment, AWSAccountBinding, RepositorySnapshot, ServiceAnalysis, DeploymentPlan, PlanApproval, Operation, Release, InfrastructureResource, CostEstimate, HealthObservation, AuditEvent and EvidenceExport.**

Agency-mode entities:

**Client and Engagement.**

### Ownership rules

Every project shall belong to exactly one organization.

Client and engagement references shall be required only for projects explicitly operating under an agency client.

For normal startup and team projects, client and engagement references shall be nullable together.

A project shall be associated with an authorized AWS account binding.

Every environment shall have explicit project ownership.

Backend authorization shall enforce organization, project, environment and client boundaries where applicable.

### Workspace modes

**TEAM:** Direct application deployment and management without client records.

**AGENCY:** The same deployment workflow with client portfolios, engagements, delegated authorization and client handoff.

Both modes shall use the same deployment engine.

---

# 7. Functional Requirements

## Module 1 — Identity and Access Management

**FR-001:** Users shall authenticate through GitHub OAuth with verified identity and revocable sessions.

**FR-002:** A platform user shall be created or linked only after successful identity verification.

**FR-003:** Users may belong to multiple organizations with isolated memberships.

**FR-004:** Organization roles shall include OWNER, ADMINISTRATOR, ENGINEER, APPROVER and VIEWER.

**FR-005:** Owners and administrators shall manage organizations, memberships, projects and applicable client records.

**FR-006:** Engineers shall analyze repositories, prepare plans and request authorized operations.

**FR-007:** Approvers shall approve or reject deployments, rollback and cleanup within their assigned scope.

**FR-008:** Viewers shall have read-only access to explicitly authorized resources.

**FR-009:** Authorization shall be enforced in APIs, background jobs, data queries, event delivery and artifact access.

**FR-010:** Revoked identity, organization membership or GitHub permission shall block new unauthorized actions.

**FR-011:** User sessions shall support server-side revocation.

**FR-012:** Privileged actions shall produce actor-, resource-, scope-, time- and outcome-bound audit records.

## Module 2 — Organizations, Projects and Agency Management

**FR-013:** Users shall create team organizations directly without creating a client.

**FR-014:** Organization owners shall create projects without requiring an external-client engagement.

**FR-015:** Agency organizations shall be able to create and manage client records.

**FR-016:** Agencies shall create engagements under clients to organize related projects and operations.

**FR-017:** Every project shall have one owning organization. Client and engagement associations shall be optional together and mandatory only for the agency client workflow.

**FR-018:** Authorized engineers shall create projects using a selected repository, AWS account binding and environment without requiring an engagement.

**FR-019:** The organization dashboard shall show projects, environments, verified releases, health and operational alerts. Agency mode shall also support client and engagement filtering.

**FR-020:** Archiving organizations, clients or engagements shall preserve required audit history and shall not automatically delete AWS workloads.

## Module 3 — AWS Account Binding and Ownership

**FR-021:** The DeployGuard control-plane AWS account shall remain distinct from customer workload accounts.

**FR-022:** Organizations shall connect AWS accounts they control. Agencies shall additionally bind client-authorized AWS accounts to engagements.

**FR-023:** AWS onboarding shall verify account identity, region, trusted role and minimum required permissions.

**FR-024:** Customer production workloads shall not be silently deployed into DeployGuard's shared control-plane AWS account.

**FR-025:** AWS operations shall use scoped temporary role credentials rather than permanently stored customer IAM access keys.

**FR-026:** Infrastructure state, operations, secrets and resource manifests shall be isolated by organization, account, project, environment and applicable client/engagement.

**FR-027:** The system shall persist account ID, region, assumed role identity, exact resource IDs, generation, environment and ownership evidence.

**FR-028:** Revoked AWS access shall prevent new mutations while retaining existing resource records and showing disconnected or unverified states accurately.

**FR-029:** The initial certified deployment region shall be `us-east-1`. Other regions shall remain unavailable until separately verified.

**FR-030:** AWS execution permissions shall be restricted to approved operations and authorized resource identities using least privilege.

## Module 4 — GitHub Repository Analysis

**FR-031:** Users shall connect GitHub repositories they are authorized to access.

**FR-032:** Repository selectors shall show only repositories permitted for the actor and organization.

**FR-033:** Users shall select a repository and source revision before analysis.

**FR-034:** Analysis shall resolve an immutable 40-character Git commit SHA.

**FR-035:** One deployment operation shall use the same immutable source SHA across analysis, build and deployment.

**FR-036:** Repository analysis shall identify language, framework, application type, deployable directory, package manager, lockfile, build/start contract, port and workspace structure.

**FR-037:** Read-only repository analysis shall not execute untrusted source code.

**FR-038:** Repository traversal shall enforce safe paths, symlink boundaries and resource limits.

**FR-039:** Unsupported or ambiguous applications shall receive actionable blocked or unsupported explanations.

**FR-040:** Analysis evidence shall retain the source SHA, analyzer version, evidence locator and timestamp.

## Module 5 — Configuration and Dependency Intelligence

**FR-041:** DeployGuard shall identify configuration requirements through repository and framework evidence.

**FR-042:** The platform shall inspect safe templates such as `.env.example` and applicable manifests without copying private secrets.

**FR-043:** Each configuration requirement shall record name, necessity, build/runtime scope, secrecy, evidence and resolution status.

**FR-044:** Missing mandatory environment variables shall be reported.

**FR-045:** The platform shall identify probable databases, caches, queues, storage and external services with evidence and confidence.

**FR-046:** Detecting a dependency shall not authorize automatic AWS provisioning.

**FR-047:** Users shall explicitly connect supported external dependencies. R1 shall not automatically provision arbitrary databases.

**FR-048:** Secret references shall be stored securely. Raw secret values shall not appear in logs, model prompts, plan JSON, evidence exports or static application bundles.

**FR-049:** Relevant configuration changes shall invalidate affected plans and approvals.

**FR-050:** The system shall identify conflicts with platform-managed variables, host binding and application port requirements.

## Module 6 — Intelligence Harness

**FR-051:** The Intelligence Harness shall gather immutable repository, build, configuration, dependency, security, pricing, policy and operational evidence.

**FR-052:** Material findings shall include provenance, source version, timestamp and CONFIRMED, INFERRED or UNKNOWN classifications.

**FR-053:** The Harness shall evaluate compatibility with supported build and runtime contracts.

**FR-054:** Infrastructure profiles that violate hard runtime, data, security, regional or operational requirements shall be rejected.

**FR-055:** Initial CPU, memory and scaling recommendations shall include assumptions and uncertainty. Estimates shall not be represented as observed production measurements.

**FR-056:** The Harness shall produce region-specific, itemized estimated costs using available authoritative pricing sources and Infracost where applicable.

**FR-057:** The Harness shall identify vulnerability findings, missing configuration, unsupported dependencies and applicable policy conflicts.

**FR-058:** Recommendations shall explain eligible choices, assumptions, risks, trade-offs and rejected alternatives.

**FR-059:** If no supported profile qualifies, the Harness shall return `NO_ELIGIBLE_PROFILE`.

**FR-060:** Equivalent immutable inputs and analyzer versions shall produce reproducible deterministic recommendations.

**FR-061:** The platform shall persist versioned analyses, source SHAs, fingerprints, evidence, policy versions and invalidation records.

**FR-062:** Analysis and infrastructure recommendations shall not mutate cloud resources.

## Module 7 — Prompt-to-Plan and AI Interaction

**FR-063:** DeployGuard shall provide natural-language interaction alongside structured configuration forms.

**FR-064:** R1 AI requests shall use a backend-controlled Amazon Bedrock adapter requiring authorized access and an enabled model.

**FR-065:** The model identifier shall be pinned and verified for the target region and required capabilities.

**FR-066:** Only sanitized, authorized project evidence shall be shared with the AI model.

**FR-067:** Supported intents shall include application analysis, requirement explanation, plan creation, configuration explanation, infrastructure comparison, cost preview, failure explanation, health summary and handoff generation.

**FR-068:** Natural-language intents shall become typed, schema-validated requests.

**FR-069:** AI shall not invent authoritative costs, live deployment states, AWS resource IDs or permissions.

**FR-070:** Missing mandatory constraints shall be requested rather than guessed.

**FR-071:** Deployment prompts shall produce reviewable plans, not immediate cloud mutations.

**FR-072:** Mutations shall require separate, approved actions tied to exact plan fingerprints.

**FR-073:** AI provider failure shall not disable deterministic analysis or conventional guided deployment.

**FR-074:** Model interactions shall enforce usage quotas, timeouts, rate limits and cost budgets.

**FR-075:** Repository content, comments, logs and prompts shall be treated as untrusted data.

**FR-076:** AI explanations shall distinguish observed facts, inferences, hypotheses and missing evidence.

## Module 8 — Deployment Plans and Approvals

**FR-077:** Every deployment shall originate from a validated, typed and versioned Deployment Plan.

**FR-078:** The plan shall include organization, project, environment, optional client/engagement, source SHA, build/runtime, account/region, hosting profile, configuration references, resources, health, security, cost and fingerprint.

**FR-079:** Approved deployment plans shall be immutable.

**FR-080:** Changes to source, configuration, profile, region, account or resources shall require a new plan revision and approval.

**FR-081:** Approvals shall bind actor, role, exact plan hash, environment, operation and budget.

**FR-082:** The user interface shall show distinct ANALYZING, INPUT_REQUIRED, BLOCKED, READY, APPROVED, EXECUTING, VERIFIED and FAILED states.

**FR-083:** Unsupported, stale, manipulated or unapproved plans shall be rejected.

**FR-084:** Expected AWS resource changes shall be previewed before infrastructure mutation.

**FR-085:** Fixed charges, variable charges, assumptions and unknown cost components shall be displayed before approval.

## Module 9 — Verified AWS Deployment

**FR-086:** Approved deployment shall use the existing GitHub Actions, Terraform and ECS architecture.

**FR-087:** Every operation shall have a unique immutable operation ID and idempotency key.

**FR-088:** GitHub workflow runs shall correlate to the exact operation identity.

**FR-089:** An unrelated or most-recent workflow run shall never be accepted as execution proof.

**FR-090:** Exact source identity, artifact digest and immutable image provenance shall be recorded.

**FR-091:** Applicable Trivy scans shall execute according to a documented severity and release policy.

**FR-092:** AWS calls shall be restricted to approved account, region, project, environment and resource scope.

**FR-093:** Operations shall expose PENDING, RUNNING, VERIFIED, FAILED, BLOCKED and UNVERIFIED states.

**FR-094:** Successful workflow completion alone shall not establish application availability.

**FR-095:** Exact ECS resource identity and applicable public health endpoints shall be verified.

**FR-096:** Concurrent mutations targeting the same environment shall follow a lock or serialization policy.

**FR-097:** Ambiguous or interrupted operations shall not silently redispatch or duplicate infrastructure.

**FR-098:** A failed new release shall preserve the previous verified healthy release where possible.

**FR-099:** The UI shall present truthful operation progress, errors and uncertainty evidence.

**FR-100:** Breaking workflow contracts shall use versioned migrations and regression tests.

## Module 10 — Static Hosting

**FR-101:** Proven static applications shall be eligible for the S3/CloudFront hosting profile.

**FR-102:** Static assets shall use private, project-isolated S3 ownership boundaries.

**FR-103:** CloudFront shall deliver static assets over HTTPS using private-origin access.

**FR-104:** SSR, HTTP APIs and runtime-dependent services shall not be deployed using static-only hosting.

**FR-105:** The exact static artifact and source identities shall be retained.

**FR-106:** Static releases shall support verification, redeployment and rollback to immutable previous versions.

**FR-107:** Cleanup shall preserve unrelated shared resources, customer domains and certificates.

## Module 11 — Monitoring and Operational Evidence

**FR-108:** Display the latest independently verified deployment state, not merely the latest workflow status.

**FR-109:** ECS projects shall show authorized service, task, target-health and endpoint information.

**FR-110:** Available CloudWatch observations shall be presented in the project dashboard.

**FR-111:** Observations shall correlate with environments, operations and immutable releases.

**FR-112:** Authorized users shall access sanitized logs, deployment errors and available alert history.

**FR-113:** Health observations shall include timestamps and FRESH, STALE, MISSING or UNVERIFIED classifications.

**FR-114:** Missing monitoring permissions or data shall never be treated as proof of health.

**FR-115:** Significant release failures shall generate in-app notifications.

**FR-116:** The system shall maintain a release timeline with SHA, actor, operation, outcome and evidence references.

## Module 12 — AWS Cost Intelligence

**FR-117:** Estimated monthly infrastructure costs shall be available before provisioning.

**FR-118:** Estimates shall include applicable compute, ALB, NAT/networking, storage, ECR, traffic, monitoring and fixed AWS costs.

**FR-119:** Estimates shall include pricing source, region, currency, timestamp and workload assumptions.

**FR-120:** AWS infrastructure expenses shall be separated from DeployGuard platform fees.

**FR-121:** Approvers shall define or confirm the estimated monthly AWS budget before new provisioning.

**FR-122:** Over-budget provisioning shall be blocked until the budget and revised plan are approved.

**FR-123:** The system shall not claim an option is cheapest without comparing complete eligible alternatives on equivalent assumptions.

**FR-124:** Missing pricing shall produce `ESTIMATE_INCOMPLETE`, not zero-cost assumptions.

**FR-125:** Actual AWS charges shall be displayed only when authorized, attributable billing data is available.

## Module 13 — Release, Rollback and Safe Cleanup

**FR-126:** Verified releases shall be recorded with immutable identities and independent verification evidence.

**FR-127:** Authorized users shall request rollback to specific previous verified releases.

**FR-128:** Rollback shall restore the recorded artifact or task definition, not rebuild a moving branch.

**FR-129:** Rollback success shall require resource and endpoint re-verification.

**FR-130:** FAILED or UNVERIFIED releases shall not replace the last verified stable release pointer.

**FR-131:** Resource deletion shall require an exact account, region, project and environment ownership manifest.

**FR-132:** Resource absence shall be independently observed using appropriate AWS APIs and bounded consistency checks.

**FR-133:** Terraform exit status alone shall not establish successful resource cleanup.

**FR-134:** Missing, corrupted, conflicting or incomplete ownership evidence shall block destructive cleanup.

**FR-135:** Shared resources, unrelated environments and persistent customer data shall remain protected.

**FR-136:** Partial cleanup shall remain recorded and shall support only safely authorized retries.

**FR-137:** Historical deployments without sufficient ownership evidence shall require authorized manual reconciliation.

**FR-138:** User suspension, organization suspension or subscription cancellation shall not automatically delete AWS workloads.

## Module 14 — Operational Evidence and Agency Handoff

**FR-139:** Every team project shall support Deployment and Operations Evidence export. Agency projects shall additionally support client-branded handoff.

**FR-140:** Evidence shall include ownership, source SHA, release identity, AWS account/region, topology, resource inventory, configuration requirement names, verified health, estimates, scans, approvals and rollback history.

**FR-141:** Evidence shall be exportable as PDF and structured JSON.

**FR-142:** Exports shall exclude credentials, raw secrets and other organizations' or clients' data.

**FR-143:** Evidence shall include timestamps, source locators, observation confidence and validity status.

**FR-144:** Missing live AWS verification shall be clearly labeled UNVERIFIED.

**FR-145:** Only authorized project users or explicitly permitted client viewers shall access exports.

## Module 15 — Essential Administration

**FR-146:** Organization owners shall manage membership, project access and agency-specific client/engagement records.

**FR-147:** DeployGuard internal administration shall use a separate authorization domain.

**FR-148:** Platform operators shall not automatically gain customer AWS execution access or access to raw secrets.

**FR-149:** Operator actions shall be authenticated, scoped and audited.

**FR-150:** Compromised accounts may be restricted without automatically deleting associated workloads.

**FR-151:** Essential internal views shall show organizations, user status, project status and operational failures.

**FR-152:** Privileged account changes shall record actor, timestamp and reason.

---

# R2 — Commercial SaaS and Operational Intelligence

## Module 16 — Subscriptions and Commercial Management

**FR-153:** Maintain versioned plans and entitlements for startup, team and agency tiers.

**FR-154:** Entitlements shall include members, projects, environments, AI usage, evidence retention and applicable agency client limits.

**FR-155:** Commercial plan changes shall preserve historical records and audit evidence.

**FR-156:** Usage shall be recorded through idempotent, immutable metering events.

**FR-157:** Generate B2B invoices with due dates, status and externally reconciled payment records. Automated card checkout is not mandatory.

**FR-158:** AWS infrastructure charges shall be separate from DeployGuard subscription charges.

**FR-159:** Authorized billing operators shall manage audited invoices, receipts, adjustments and disputes.

**FR-160:** Overdue or cancelled subscriptions may restrict new platform operations according to policy but shall not automatically destroy AWS resources.

**FR-161:** Organization administrators shall view subscriptions, usage and invoices.

**FR-162:** Subscription transitions shall not duplicate billing or metering events.

## Module 17 — Platform Operations and Super Administration

**FR-163:** Internal roles shall include SUPER_ADMIN, PLATFORM_OPS, SUPPORT, BILLING and SECURITY_AUDITOR.

**FR-164:** Administrative searches and views shall enforce the assigned authorization scope.

**FR-165:** Suspension, reinstatement and entitlement changes shall require reasons and audit records.

**FR-166:** Sensitive actions shall require additional identity verification or approved privileged controls.

**FR-167:** Support access shall be time-limited, purpose-bound and audited.

**FR-168:** Administrative operations shall preserve workload ownership, evidence and recovery records.

## Module 18 — API Assurance and Incident Intelligence

**FR-169:** The platform shall correlate incidents with immutable releases, metrics, logs, AWS events and timestamps.

**FR-170:** Incident findings shall distinguish FACT, HYPOTHESIS and MISSING_EVIDENCE.

**FR-171:** AI-assisted incident investigation shall operate through read-only authority.

**FR-172:** Supported API projects shall allow registration of authorized health endpoints and OpenAPI contracts.

**FR-173:** API regression and contract-fuzzing tests shall run only against approved staging or sandbox environments.

**FR-174:** Contract test results shall retain source SHA, target, specification, execution and result identities.

**FR-175:** Incident recommendations shall cite operational evidence and shall not authorize direct AI cloud mutations.

## Module 19 — Evidence-Based Optimization

**FR-176:** The system shall compare observed workload behavior with current resource allocation.

**FR-177:** CPU, memory and replica recommendations shall require adequate time-windowed observations.

**FR-178:** Recommendations shall disclose expected cost and reliability effects, evidence windows and confidence.

**FR-179:** Applying an optimization shall require a new approved, fingerprinted plan.

**FR-180:** Failed optimization shall preserve or restore the previously verified configuration.

---

# R3 — Governed Self-Healing and Code Repair

## Module 20 — Approved Recovery Runbooks

**FR-181:** Maintain a versioned registry of approved recovery runbooks with explicit preconditions.

**FR-182:** Initial recovery actions shall support verified rollback, idempotent deployment retry, scoped ECS restart and bounded replica adjustment.

**FR-183:** Recovery shall require verified incident, resource ownership and authorization context.

**FR-184:** Permissions, resource ownership and runbook preconditions shall be checked immediately before mutation.

**FR-185:** Production changes shall require human approval or a separately authorized bounded automation policy.

**FR-186:** Recovery shall enforce execution locks, cost limits, retry ceilings, timeouts and exact resource scope.

**FR-187:** Post-action application and infrastructure health shall be verified.

**FR-188:** Failed recovery shall remain FAILED or UNVERIFIED rather than being presented as resolved.

**FR-189:** AI shall not execute arbitrary shell commands, escalate IAM permissions or delete resources.

**FR-190:** Approval, execution, outcomes and verification shall be retained as operational evidence.

## Module 21 — Supervised Application Code Repair

**FR-191:** Repair attempts shall require reproducible defect evidence and bounded patch scope.

**FR-192:** Generated changes shall run in an isolated sandbox without production credentials.

**FR-193:** Proposed changes shall be submitted as attributable, reviewable GitHub pull requests.

**FR-194:** Repairs shall undergo relevant automated and authorized API contract tests.

**FR-195:** Checks shall be reported as PASSED, FAILED or UNVERIFIED.

**FR-196:** Protected production branches shall not receive automatically merged AI-generated patches.

**FR-197:** Repaired code shall deploy through the established approved deployment and verification pipeline.

**FR-198:** Repair success shall require independently verified operational recovery.

---

## 8. Non-Functional Requirements

### Security — NFR-001 to NFR-008

- Enforce tenant, client, project, environment and action-scoped authorization.
- Use HTTPS for external communication.
- Encrypt sensitive credentials and restrict their use.
- Use temporary, least-privilege AWS role credentials.
- Preserve tamper-sensitive privileged audit records.
- Fail closed when deletion ownership is uncertain.
- Sanitize AI context and protect customer secrets.
- Sandbox or safely inspect untrusted repository content.

### Reliability — NFR-009 to NFR-013

- User-visible success must require authoritative evidence.
- Deployment and recovery retries must be idempotent.
- Failed releases must preserve verified stable releases where possible.
- Partial operations must remain visible and recoverable.
- Target 99.5% monthly control-plane availability after production launch, subject to measurement and certification. This is an engineering objective, not a guaranteed SLA.

### Performance — NFR-014 to NFR-017

- Standard authenticated API requests shall target p95 server response below one second under the declared pilot load.
- Supported repository analysis shall target completion within two minutes for fixtures up to 200 MB and 5,000 tracked files, excluding external service timeouts.
- Long-running deployments and builds shall execute asynchronously with progress reporting.
- Repository scanning, model interactions and analysis operations shall have resource limits.

### Retention and Recovery — NFR-018 to NFR-022

- Temporary repository checkouts shall be cleaned up within one hour of operation completion.
- Active-pilot operational evidence shall be retained for at least 90 days.
- Privileged audit evidence shall target 365 days of retention, subject to applicable legal and data requirements.
- PostgreSQL backups shall be encrypted and restore-tested.
- The initial metadata recovery objectives shall target RPO 24 hours and RTO 24 hours, verified before production certification.

### Maintainability — NFR-023 to NFR-028

- Preserve the modular NestJS architecture.
- Use typed, versioned cross-component interfaces.
- Reuse exact-SHA source analysis and the canonical Deployment Plan.
- Use backward-compatible or reversible migrations.
- Reduce duplication and unnecessary abstractions.
- Pin and review open-source dependencies for licensing, security and maintenance.

### Cost and Operational Safety — NFR-029 to NFR-033

- AWS provisioning requires explicit approval of an estimated cost-bearing plan.
- AWS budget alerts shall not be treated as hard spending limits.
- DeployGuard shall enforce limits on concurrent execution, AI usage and repeated operations.
- Initial per-organization model limits shall default to 100 assisted requests and USD 5 tracked inference spending per day, unless another approved entitlement applies.
- Live AWS testing requires an approved account, region, spending limit and cleanup plan.

---

## 9. Intelligence Harness Architecture

The Harness shall comprise six logically separated internal components within the existing NestJS backend.

### IH-001 — Context Engine

Collect evidence from:

- Immutable GitHub source snapshots.
- Application manifests and build contracts.
- Environment configuration and dependency analysis.
- Deployment and release history.
- AWS resources.
- Cost and security reports.
- Available monitoring information.

### IH-002 — Specialist Adapter Layer

Reuse existing Railpack, Trivy, Infracost, Terraform, GitHub Actions and AWS integrations.

Additional telemetry, API testing, incident-analysis and recovery tools shall be integrated only in their corresponding approved release stages.

### IH-003 — AI Reasoning Interface

Use the controlled Bedrock adapter for authorized natural-language interpretation and explanations.

AI output shall be schema-validated and shall not become independent infrastructure execution authority.

### IH-004 — Deterministic Decision Engine

Evaluate hard requirements, certified hosting capabilities, security constraints, pricing evidence and infrastructure eligibility.

### IH-005 — Execution Gateway

Authorize only exact, fingerprint-bound operations with verified user identity, project ownership, permitted AWS resources and required approvals.

### IH-006 — Evaluation Engine

Maintain test fixtures for:

- Correct application classification.
- Supported and unsupported deployment profiles.
- Missing configuration.
- Inaccurate or incomplete pricing.
- Prompt injection.
- Unauthorized AWS operations.
- Stale source commits.
- Invalid deployment plans.
- Incomplete ownership manifests.
- Deployment success and failure evidence.

---

## 10. Primary User Journeys

### Journey A — Startup or Development Team

1. Login through GitHub.
2. Create a team organization.
3. Connect an authorized AWS account.
4. Create a project directly, without a client or engagement.
5. Choose a repository, source revision and environment.
6. Run Intelligence Harness analysis.
7. Provide missing application requirements.
8. Enter the expected workload and infrastructure budget.
9. Review eligible architecture options and cost assumptions.
10. Use a prompt or visual interface to prepare the deployment plan.
11. Approve the immutable plan.
12. Execute the deployment through approved AWS workflows.
13. Verify infrastructure and application health.
14. Monitor application status and costs.
15. Redeploy, roll back or request cleanup when authorized.
16. Export operational evidence.

### Journey B — Software Agency

1. Create an agency organization.
2. Create a client.
3. Create a client engagement.
4. Bind the client-authorized AWS account.
5. Create a project associated with the engagement.
6. Follow the same core deployment process as Journey A.
7. Enforce client-scoped access and AWS ownership.
8. Generate a branded client handoff containing deployment and operational evidence.

### Prompt Interaction

User Prompt → Typed Intent Validation → Intelligence Harness → Missing Requirements → Eligible Infrastructure Plan → Cost and Security Review → Explicit Approval → Deployment → Independent Verification.

Prompting alone shall never authorize infrastructure mutation.

---

## 11. R1 Acceptance Tests

**AT-001 — Team Onboarding**

A startup user successfully creates an organization, binds AWS, creates a project and completes deployment without creating a client or engagement.

**AT-002 — Agency Onboarding**

An agency creates client and engagement records, binds a client-authorized account and uses the same deployment pipeline.

**AT-003 — Isolation**

Users cannot access another organization's repositories, environments, resource IDs, secrets, cost records or deployment evidence.

**AT-004 — Application Compatibility**

Supported Node.js and Python HTTP applications build and deploy using an immutable source SHA. Unsupported runtimes fail with actionable explanations.

**AT-005 — Static Hosting**

A verified React/Vite static application deploys through private S3 and CloudFront with HTTPS, release identity, rollback and controlled cleanup.

**AT-006 — Intelligence Harness**

Configuration gaps are identified, unsupported profiles are rejected, cost uncertainty is disclosed and equivalent inputs produce repeatable results without AWS mutations.

**AT-007 — Prompt-to-Plan**

Natural-language requests create validated plans, request missing constraints and cannot bypass approval or authorization.

**AT-008 — Verified Deployment**

An operation's GitHub workflow, source SHA, image identity, resource identity and endpoint verification agree before it is marked successful.

**AT-009 — Rollback and Cleanup**

Rollback restores an immutable previous release. Cleanup verifies precise owned-resource absence and protects shared resources. Missing historical evidence blocks unauthorized deletion.

**AT-010 — Monitoring and Evidence**

Unverified health observations are not displayed as healthy. Evidence reports are available as sanitized PDF and JSON.

**AT-011 — Commercial Pilot**

At least two representative full-journey demonstrations shall be independently reviewed: one startup/team workflow and one agency workflow.

Record measured deployment effort, user intervention, cost assumptions, failures and recovery results.

---

## 12. Release Completion Criteria

### R1 Completion

R1 is complete when:

- Startup/team onboarding works without agency-specific records.
- Agency management works as an extension of the same application workflow.
- Relevant user, project and AWS ownership boundaries are enforced.
- Application analysis identifies supported deployment requirements.
- The Intelligence Harness produces explainable, valid recommendations.
- Prompt-based planning is integrated with deterministic validation.
- Supported AWS hosting profiles pass their certification requirements.
- Deployment and rollback statuses use authoritative evidence.
- Monitoring reflects actual observation state.
- Cleanup is ownership-scoped and independently verified.
- Operational evidence exports are complete and secure.
- The entire user journey has passed required integration and authorized real-provider certification.

### R2 Completion

R2 is complete when:

- Subscription, usage and invoice information is accurate.
- Platform administration follows distinct privileged roles.
- Incident investigation uses operational evidence.
- API regression runs only in approved environments.
- Optimization recommendations use actual workload measurements.
- R1 functionality remains compatible and operational.

### R3 Completion

R3 is complete when:

- Recovery runbooks enforce exact authorization and resource ownership.
- Operational remediation follows approved policies.
- Recovery outcomes are independently verified.
- Failed recoveries are not reported as resolved.
- Code repair occurs in an isolated environment.
- AI-generated changes require review and approved deployment.
- No unrestricted automated production mutations are possible.

---

## 13. Engineering Requirements

The existing DeployGuard Engineering OS shall remain the development operating framework.

Its documents are:

- `docs/engineering/01_PRODUCT_SCOPE.md`
- `docs/engineering/02_ARCHITECTURE_CONTRACTS.md`
- `docs/engineering/03_ENGINEERING_WORKFLOW.md`
- `docs/engineering/04_CURRENT_STATE.md`

`AGENTS.md` shall remain the lightweight navigation and safety entry point.

The implementation roadmap shall map requirements to actual code and milestones.

### Development rules

- Develop complete vertical slices.
- Use existing code and interfaces before introducing replacements.
- Employ specialized Codex roles only when relevant.
- Use ECC, Ponytail and AWS skills selectively.
- Optimize for completed, verified features per development window.
- Run focused tests during implementation.
- Run complete regression checks at stable integration boundaries.
- Avoid repeating full certification unnecessarily.
- Do not weaken security or infrastructure ownership checks.
- Maintain progress records and exact implementation status.
- Do not push, merge or change live AWS resources without explicit approval.

---

## 14. Product Exclusions

The approved release strategy excludes:

- Microservices migration.
- Kubernetes or EKS orchestration.
- Multi-cloud deployment.
- A general-purpose AWS chatbot with unrestricted execution.
- Training proprietary foundation models.
- Universal support for all programming languages.
- Automatic provisioning of arbitrary databases.
- Unrestricted IAM or Terraform modification by AI.
- A separate developer portal framework.
- Unsupervised merging of AI-generated production code.
- Automatic deletion of customer workloads for billing or user-account changes.
- Mandatory card-based checkout during initial commercialization.

Additional features require a formal scope change.

---

## 15. Business Model and Market Validation

### Commercial customers

Primary:

- Startups.
- Small and medium-sized development teams.
- SaaS product teams without dedicated platform engineering capacity.

Secondary:

- Software agencies.
- AWS consultants.
- DevOps service providers.

### Revenue model

DeployGuard shall use organization-based SaaS subscriptions.

Entitlements shall include team size, projects, environments, AI usage and evidence retention.

Agency tiers shall additionally support client and engagement entitlements.

Customers remain responsible for AWS infrastructure charges.

Initial commercialization shall use controlled pilot agreements and invoice-based billing.

### Validation targets

- Ten focused customer interviews.
- Three qualified pilot candidates.
- Two completed end-to-end demonstrations.
- Measured engineering effort and deployment correctness.
- Evidence of customer willingness to pay.

These are targets rather than claims of existing customer traction.

---

## 16. Implementation Priority

| Stage | Deliverable |
|---|---|
| 1 | Finish existing ECS lifecycle stabilization |
| 2 | Implement secure AWS account binding and ownership contracts |
| 3 | Simplify repository analysis and establish DeploymentPlan/v1 |
| 4 | Stabilize build, ENV and dependency intelligence |
| 5 | Implement team/project ownership and agency extensions |
| 6 | Deliver the complete R1 Intelligence Harness |
| 7 | Implement prompt-to-plan interaction and approvals |
| 8 | Complete static hosting and supported deployment profiles |
| 9 | Integrate monitoring and cost visibility |
| 10 | Deliver operational evidence exports and agency handoff |
| 11 | Complete authorized R1 integration and AWS certification |
| 12 | Deliver R2 commercialization and incident intelligence |
| 13 | Deliver R3 governed recovery and supervised repair |

The implementation roadmap must map these stages to existing M0–M19 work without discarding verified progress.

---

## 17. Requirements Governance and Approval

This PRD v1.1 preserves FR-001 through FR-198 from the previous baseline while changing the customer model and user journeys to support startups and development teams directly.

Upon founder approval:

1. PRD v1.1 becomes the authoritative product requirements document.
2. PRD v1.0 becomes historical reference material.
3. The previous master implementation specification becomes technical reference material, not a competing requirements source.
4. `docs/engineering/01_PRODUCT_SCOPE.md` summarizes the active release.
5. `docs/engineering/02_ARCHITECTURE_CONTRACTS.md` defines implementation boundaries.
6. `docs/engineering/03_ENGINEERING_WORKFLOW.md` controls development procedures.
7. `docs/engineering/04_CURRENT_STATE.md` records actual verified progress.
8. `docs/implementation/IMPLEMENTATION_ROADMAP.md` maps requirements to milestones, dependencies and acceptance tests.
9. Existing verified work and commits remain preserved.
10. Scope changes require a new versioned change request.

Implementation evidence shall be classified as:

- NOT_STARTED
- PARTIAL
- LOCAL_VERIFIED
- AWS_VERIFIED
- BLOCKED

No feature shall be represented as production-certified without the required real-provider evidence.

**Founder approval is approval of the product requirements, not permission to spend money, modify live AWS infrastructure, deploy to production, or perform destructive operations.**

---

## Final Product Definition

**DeployGuard is an intelligent AWS deployment and operations platform for startups, software teams and agencies.**

Its central capability is an **Intelligence Harness** that brings together application understanding, AWS infrastructure planning, cost and security evidence, natural-language interaction, and controlled deployment workflows.

The product shall simplify AWS engineering while preserving customer infrastructure ownership, transparent decision-making and independently verified operational results.

**End of DeployGuard PRD v1.1**
