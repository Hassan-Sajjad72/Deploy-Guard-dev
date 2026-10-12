ZERO certification runs until the entire approved implementation scope is complete. No module-level certification, repeated full test suites, or intermediate certification gates. During development, only focused tests necessary to validate changed functionality are allowed. Once full implementation is finished, conduct one comprehensive certification phase.

# DEPLOYGUARD — TARGETED PRD CORRECTIONS

**Target document:** Existing `docs/product/PRD_v1.1.md`  
**Change type:** In-place correction of the approved product baseline  
**Source of corrections:** Existing DeployGuard codebase audit and agreed product direction  
**Scope:** Preserve existing platform capabilities, repair incorrect assumptions, and extend deployment options without rebuilding the platform

## 1. Replace Section 1 — Product Definition

DeployGuard is an AI-powered AWS deployment and operations platform that enables individual developers, startups, software teams, and agencies to analyze applications, select suitable AWS infrastructure, deploy services, monitor operations, manage costs, and recover from failures through a unified control plane.

DeployGuard operates primarily through a Bring Your Own Cloud (BYOC) model. Customer workloads are deployed into authorized customer AWS accounts, while DeployGuard operates its own control plane.

During development, the founder's AWS account may act as a simulated customer account using isolated resources and authorized testing boundaries. This does not constitute verification of true cross-account isolation.

### Core Product Value

DeployGuard shall simplify AWS infrastructure management while preserving:

- Customer ownership of deployed resources.
- Cost-effective hosting choices.
- Transparent infrastructure costs.
- Secure, authorized AWS operations.
- Reliable deployment and rollback.
- Application and infrastructure monitoring.
- Existing multi-service deployment capabilities.
- AI-assisted planning and troubleshooting.
- Verified operational evidence.

### Core Workflow

Connect GitHub → Analyze Application → Identify Requirements → Compare AWS Hosting Options → Estimate Costs → Generate Deployment Plan → Approve → Deploy → Verify → Monitor → Optimize or Recover.

The platform shall support both guided dashboard workflows and natural-language interaction.

### Primary Customers

- Individual developers with their own AWS accounts.
- Startups.
- Small and medium-sized software development teams.
- SaaS development teams.

### Secondary Customers

- Software agencies.
- AWS consultancies.
- DevOps service providers.

Client and engagement management shall remain optional and shall never be required for individual or standard team deployment.

---

## 2. Replace Section 4 — Product Release Boundaries

### R1 — Intelligent, Cost-Aware AWS Deployment and Operations

R1 shall build upon the existing DeployGuard platform rather than replace it.

### Existing capabilities to preserve and extend

The existing codebase contains implementations of:

- GitHub OAuth authentication and role-based access.
- Project and repository management.
- Repository, workspace, framework, build-target, and port analysis.
- Railpack builds and controlled Dockerfile fallback.
- Multi-service application deployments.
- Service-scoped build and runtime environment variables.
- Explicit PostgreSQL, MySQL, and MongoDB attachments.
- Terraform and GitHub Actions deployment execution.
- AWS ECS Fargate infrastructure integration.
- Deployment, redeployment, rollback, release history, and cleanup.
- Trivy vulnerability scanning.
- CloudWatch metrics and logs.
- Prometheus integration and Grafana dashboards.
- Infracost-based cost evidence.
- Evidence-based AI troubleshooting using Gemini.
- SNS notifications.
- Subscription plans, trials, Stripe integration, invoices, and Terraform export.

These capabilities must not be removed or rewritten merely because they were omitted from a previous PRD section.

Their production readiness must be determined individually. Existing local implementation is not equivalent to real AWS certification.

### R1 improvements

R1 shall prioritize:

1. Secure individual and organizational AWS account onboarding.
2. End-to-end tenant and project isolation.
3. Unified application and infrastructure analysis.
4. Cost-aware AWS hosting selection.
5. Immutable infrastructure plans and approval.
6. Verified deployment and health monitoring.
7. Retained rollback, multi-service, database attachment, notification, monitoring, and billing functionality.
8. Operational evidence and recovery.

### Hosting profiles

DeployGuard's supported AWS deployment architecture shall include the following profiles:

**Profile A — ECS Fargate**

Existing managed container deployment path. Preserve and stabilize its current implementation.

**Profile B — Amazon EC2**

Cost-oriented deployment for compatible applications requiring persistent or continuously running compute.

Support appropriate instance families, architectures, networking, storage, and restart policies.

**Profile C — Amazon Lightsail**

Budget-oriented deployment for simple websites, small services, and suitable startup applications.

Consider plan limitations, networking, storage, scaling, regional availability, and operational trade-offs.

**Profile D — AWS Lambda**

Usage-based deployment for compatible serverless HTTP and event-driven applications.

Evaluate execution limits, request patterns, statefulness, startup behavior, integration costs, and service compatibility.

**Profile E — Amazon S3 + CloudFront**

Static application deployment without persistent application compute.

Appropriate for verified static React/Vite and similar applications.

### Hosting rollout policy

- Preserve ECS Fargate as the existing implementation.
- Prioritize EC2 and Lightsail as the next budget-oriented compute integrations.
- Implement static hosting and Lambda through the same validated planning and execution contracts.
- Enable each hosting profile only after completing its compatibility, security, infrastructure ownership, rollback, cleanup, and cost verification requirements.
- A profile may remain unavailable while its implementation or certification is incomplete.
- Do not represent an unimplemented profile as available to customers.
- R1 commercial readiness requires at least one independently verified low-cost compute alternative to Fargate, alongside the existing container deployment path. Additional profiles may be released incrementally.

### R2 — Commercial and Operational Intelligence Expansion

R2 shall extend existing billing and operations rather than rebuild them.

Required extensions include:

- Organization-scoped subscriptions and entitlements.
- Preservation and adaptation of existing Stripe functionality.
- Usage and invoice reconciliation.
- Operational incident investigation.
- API assurance.
- Measured AWS resource optimization.
- Enhanced administration and reporting.

### R3 — Governed Recovery and Repair

Preserve the existing troubleshooting and rollback functionality.

Add approved operational runbooks, bounded remediation, and supervised code-repair proposals without introducing unrestricted production mutation.

---

## 3. Replace Section 5 — Technology Architecture

### Existing Core Architecture

| Area | Existing technology |
|---|---|
| Frontend | React/Vite with JavaScript and existing frontend tooling |
| Backend | NestJS with TypeScript |
| Database | PostgreSQL and TypeORM |
| Authentication | GitHub OAuth and existing administrator authentication |
| CI/CD | GitHub Actions |
| Application builds | Railpack and controlled Dockerfile fallback |
| Infrastructure | Terraform |
| Existing compute | ECS Fargate |
| Container registry | Amazon ECR |
| Networking | VPC, security groups, ALB, Cloud Map |
| Secrets | Existing AWS Secrets Manager integration |
| Persistent storage | EFS for supported attached database workloads |
| Monitoring | CloudWatch, Prometheus, Grafana |
| Vulnerability scanning | Trivy |
| Cost integration | Infracost |
| AI troubleshooting | Existing Gemini provider integration |
| Notifications | Amazon SNS |
| Billing | Existing Stripe integration |
| Storage/state | Existing S3-backed Terraform infrastructure state and related services |

### Planned Extensions

- Amazon EC2 deployment profile.
- Amazon Lightsail deployment profile.
- AWS Lambda deployment profile and required HTTP/event integrations.
- Amazon S3 and CloudFront static hosting profile.
- Customer-scoped IAM/STS execution.
- Cost-aware hosting comparison.
- Unified Intelligence Harness.
- Natural-language deployment planning.
- Additional AI providers only when justified.

### Architecture Rules

1. Preserve the existing modular NestJS monolith.
2. Preserve existing React/Vite functionality; do not mandate a complete JavaScript-to-TypeScript migration.
3. Preserve Gemini troubleshooting. Do not replace it with Bedrock solely because the previous PRD named Bedrock.
4. Use a provider adapter so additional authorized AI providers can be introduced without rebuilding existing functionality.
5. Preserve Terraform and GitHub Actions as the infrastructure execution foundation.
6. Extend hosting support through validated provider-specific deployment components sharing common planning, ownership, approval, operation identity, and evidence contracts.
7. Preserve existing multi-service deployments and supported database attachments.
8. Avoid microservices migration, Kubernetes, additional orchestration frameworks, or unnecessary infrastructure rewrites.
9. Customer AWS mutations must use authorized temporary credentials.
10. Protect unrelated resources and preserve strict cleanup ownership evidence.

---

## 4. Replace Section 6 — Domain Model and Ownership

### Existing System Compatibility

The current platform uses user-owned projects and existing project, service, deployment, billing, monitoring, and audit records.

The new organization and customer AWS account model shall extend these entities through explicit, safe migrations.

Existing projects, deployments, database attachments, release history, subscriptions, and audit records shall not be deleted or silently reassigned during migration.

### Customer Workspace Model

**PERSONAL**

A single developer may use DeployGuard with their own GitHub identity and authorized AWS account.

The internal representation may be a single-member organization.

**TEAM**

Multiple authorized users manage projects belonging to one organization.

**AGENCY**

The organization may additionally manage clients, engagements, and client-authorized AWS accounts.

### Ownership Requirements

- Each project shall have one authoritative owner or owning organization.
- Existing user-owned records shall migrate through explicit, validated ownership rules.
- Existing project permissions shall remain protected throughout migration.
- Organization membership shall be enforced by the backend.
- Every customer deployment shall resolve to the authorized AWS account and environment.
- Different organizations shall not access each other's infrastructure state, secrets, resources, operations, monitoring, billing data, or evidence.
- Clients and engagements shall remain optional for personal and team workspaces.
- Historical resource ownership shall remain fail-closed when evidence is insufficient.

---

## 5. Replace Only These Functional Requirements in Section 7

All other FR-001 through FR-198 requirements remain unchanged.

### Identity and Workspace

**FR-013:** An individual GitHub user shall be able to create or receive a personal workspace without creating an external client, engagement, or additional team membership.

**FR-014:** Users shall create and manage projects under an authorized personal or team organization while retaining access to safely migrated existing projects.

**FR-017:** Projects shall migrate from existing user-scoped ownership toward authoritative organization ownership without losing existing deployments, permissions, operational history, or evidence.

**FR-018:** Authorized users shall create and manage projects using repositories and AWS account bindings without requiring agency-specific records.

### AWS Account Binding

**FR-021:** DeployGuard shall use the Bring Your Own Cloud model. The platform control plane and customer workload execution shall have logically separate authorization and resource ownership boundaries.

**FR-022:** Personal users and organizations shall connect AWS accounts they are authorized to control. Agencies shall additionally support explicitly authorized client AWS accounts.

**FR-023:** AWS onboarding shall verify account identity, assumed role, trust policy, permitted region, required permissions, and scoped execution authority before enabling mutations.

**FR-024:** Customer production workloads shall execute only in explicitly authorized customer account bindings. Development testing in the founder's account may use isolated test resources under separate approval; it shall not be treated as proof of production customer isolation.

**FR-029:** Deployment regions shall be enabled per independently validated hosting profile. The system shall not claim a region is AWS-certified before real-provider verification.

### Existing Application and Database Intelligence

**FR-036:** Reuse existing exact-SHA repository analysis, directory discovery, workspace inspection, build-target resolution, runtime configuration, port detection, and multi-service discovery when producing application intelligence.

**FR-041:** The Intelligence Harness shall extend existing environment-variable and application configuration analysis rather than replacing verified resolvers.

**FR-045:** Analysis shall recognize database attachments, external services, storage, caches, and application dependencies. Existing explicit PostgreSQL, MySQL, and MongoDB attachment capabilities shall be retained with their actual operational limitations clearly stated.

**FR-047:** Supported existing database attachment workflows shall remain available through explicit user authorization. New dependency provisioning shall require an approved deployment plan and compatible hosting profile; arbitrary unsupported databases shall not be provisioned automatically.

### Intelligence Harness and Hosting Selection

**FR-053:** The Intelligence Harness shall evaluate application compatibility against enabled AWS hosting profiles, including ECS Fargate, EC2, Lightsail, Lambda, and static hosting as each becomes certified.

**FR-054:** Hosting options shall be rejected when they violate runtime, dependency, statefulness, region, budget, security, networking, persistence, or operational requirements.

**FR-055:** CPU, memory, storage, scaling, availability, and traffic assumptions shall be recorded before estimating cost or recommending infrastructure.

**FR-056:** The Harness shall calculate itemized, profile-specific estimated monthly AWS costs using relevant pricing sources, existing Infracost integration where applicable, and explicit usage assumptions.

**FR-058:** The platform shall compare eligible AWS hosting options using estimated total cost, reliability, operational effort, scaling characteristics, infrastructure constraints, and security requirements.

**FR-059:** When no hosting option is both compatible and within the approved budget, the system shall return an explicit blocked or no-eligible-profile result, including the reasons.

### AI Integration

**FR-064:** Preserve the existing Gemini troubleshooting integration. Natural-language planning shall use a backend-controlled AI provider interface supporting configured, authorized providers. Additional Bedrock support may be introduced without making migration a prerequisite for existing functionality.

**FR-065:** Every enabled AI provider shall use explicitly configured and verified model identifiers, credentials, quotas, regional constraints where applicable, and usage limits.

**FR-073:** AI provider outages shall not disable existing deterministic repository analysis, guided deployment, monitoring, troubleshooting evidence, or conventional infrastructure operations.

### Deployment Planning and Execution

**FR-077:** Every new plan-driven deployment shall use a validated, versioned Deployment Plan. Existing deployment workflows shall transition through compatible interfaces without unnecessary rebuilding or loss of multi-service support.

**FR-078:** A Deployment Plan shall include organization and account ownership, repository SHA, deployable services, selected AWS hosting profile, resource configuration, environment references, dependencies, cost breakdown, security findings, approvals, and immutable operation identity.

**FR-084:** Users shall review the selected hosting architecture, expected resources, estimated recurring costs, deployment risks, and infrastructure changes before approval.

**FR-085:** Cost estimates shall distinguish known charges, variable usage charges, pricing assumptions, missing prices, and optional services. Unknown amounts shall never be represented as zero.

**FR-086:** Preserve the existing GitHub Actions, Terraform, Railpack, and ECS deployment path. New AWS compute profiles shall use compatible, authorized execution integrations while retaining source identity, operation correlation, resource ownership, rollback, and cleanup protections.

**FR-095:** Deployment verification shall distinguish infrastructure readiness, transport connectivity, and application-level health. HTTP application errors such as status 500 shall not be presented as verified application health.

### Monitoring and Cost Intelligence

**FR-110:** Preserve and extend existing CloudWatch, Prometheus, Grafana, and sanitized log integrations. Monitoring data shall be scoped to the authorized customer AWS account and project.

**FR-117:** Estimated AWS infrastructure cost shall be available before a new deployment is approved, while preserving existing release-oriented Infracost evidence.

**FR-118:** Total-cost estimates shall include applicable compute, networking, load balancing, storage, persistent databases, data transfer, request charges, monitoring, and other required hosting-specific charges.

**FR-119:** Cost evidence shall identify hosting profile, AWS region, pricing source, timestamp, usage assumptions, and estimate limitations.

**FR-123:** DeployGuard shall recommend a lowest-estimated-cost eligible option only after comparing alternatives with equivalent workload and reliability assumptions. The system shall explain cases where a higher-cost option offers meaningful operational advantages.

**FR-124:** Missing or unreliable pricing data shall produce an incomplete estimate, not a zero-cost estimate.

### Evidence and Billing

**FR-139:** Preserve existing Terraform export, release evidence, and audit functionality. Extend these into operational evidence exports and optional agency handoff, without removing existing export formats.

**FR-141:** Existing Terraform ZIP export shall remain supported. Structured JSON and PDF operational evidence exports shall be added as distinct capabilities.

**FR-153:** Preserve the existing subscription, trial, usage, and entitlement implementation while extending ownership and permissions to organization-based accounts.

**FR-157:** Preserve existing Stripe sandbox checkout, webhook, billing portal, and invoice capabilities. Enhance billing reconciliation and organization ownership as needed. Invoice-based B2B payment support shall be an additional commercial option, not a replacement requirement.

---

## 6. Replace Section 9 — Intelligence Harness Architecture

The Intelligence Harness shall be an integration and decision layer built around DeployGuard's existing application analysis, deployment, cost, security, monitoring, and troubleshooting capabilities.

It shall not rebuild these systems unnecessarily.

### Component 1 — Application Context

Reuse:

- Exact-SHA repository inspection.
- Application and workspace discovery.
- Build-target resolution.
- Runtime and environment-variable analysis.
- Service and dependency detection.
- Existing deployment and release metadata.

### Component 2 — Infrastructure Compatibility

Evaluate whether the analyzed application can run using each enabled hosting profile.

Examples:

**Static frontend:** Evaluate S3/CloudFront.

**Small continuously running API:** Evaluate EC2, Lightsail, and ECS Fargate.

**Intermittent stateless API:** Evaluate Lambda when the application meets serverless constraints.

**Multi-service application:** Preserve the existing ECS-based deployment path and compare alternative profiles only when they can satisfy the entire service/dependency contract.

Unsupported workloads shall be rejected with explanations rather than force-fitted into cheaper hosting.

### Component 3 — Cost Intelligence

Use existing Infracost and compatible AWS pricing integrations.

Compare complete infrastructure costs for the same assumed workload.

Include service-specific network, storage, traffic, monitoring, and management requirements.

Never recommend an option based only on instance rental price.

### Component 4 — AI Reasoning

Reuse the existing AI troubleshooting provider integration.

Extend the system with controlled natural-language planning through a validated AI provider adapter.

AI may interpret user goals and explain evidence, but shall not execute AWS mutations independently.

### Component 5 — Deterministic Planning

Produce a versioned Deployment Plan containing selected architecture, application compatibility, estimated cost, required permissions, configuration, security findings, and exact execution scope.

### Component 6 — Controlled Execution

Execute only approved plans using authorized account credentials and hosting-specific workflows.

Preserve existing operation identity, rollback, resource ownership, and deletion safeguards.

### Component 7 — Operational Feedback

Use CloudWatch, Prometheus, Grafana, deployment history, security findings, and existing troubleshooting capabilities to inform operational recommendations.

Observed production metrics must remain distinguishable from estimates and AI hypotheses.

---

## 7. Amend Section 8 — Non-Functional Requirements

Retain all existing NFR identifiers and categories.

Add these implementation constraints under the appropriate existing categories:

### Security and Isolation

- Fix server-side session revocation.
- Enforce database TLS certificate verification when SSL is enabled.
- Enforce organization and AWS account isolation across APIs, jobs, streams, background operations, and exports.
- Never accept ambiguous historical resource ownership for destructive operations.

### Reliability

- Application-level HTTP errors must not be reported as healthy merely because the transport responded.
- Preserve existing multi-service deployments, rollback, and database attachment functionality.
- Protect retained audit history from project deletion cascades.

### Cost Correctness

- Unknown AWS resource prices must not silently normalize to zero.
- All budget comparisons must use applicable total-cost estimates.
- Instance pricing shall not be compared without required network, storage, operational, and usage costs.
- Spot or interruption-prone compute options shall require workload compatibility and explicit disclosure.

### Development Efficiency

- Use focused testing during implementation.
- Perform one planned complete local certification per completed module or stable integration boundary.
- If certification identifies a defect, repair and verify the affected checks before any necessary repeat of failed gates.
- Do not re-certify unchanged modules or repeat completed M0 certification without a relevant code change.
- Real AWS certification remains separately authorized.

---

## 8. Amend Section 11 — R1 Acceptance Tests

Preserve AT-001 through AT-011, subject to these clarifications:

**AT-001 — Individual and Team Onboarding**

An individual GitHub user can create a personal workspace, connect an authorized AWS account, create a project, and perform an approved deployment without creating an agency client or engagement.

**AT-004 — Application Compatibility**

Supported Node.js and Python applications retain existing repository, build, configuration, and multi-service handling. Existing supported database attachment workflows remain available for compatible profiles.

**AT-006 — Intelligence Harness**

The Harness compares enabled AWS deployment profiles using compatibility evidence and itemized estimated total cost, identifies missing configuration, and never represents unknown pricing as zero.

Add the following acceptance tests:

**AT-012 — Cost-Aware Compute Selection**

For representative eligible workloads, DeployGuard shall compare the available budget-oriented compute options against ECS Fargate.

Each comparison shall include relevant networking, storage, monitoring, application compatibility, and estimated recurring charges.

The platform shall identify the lowest-estimated-cost eligible option for a stated workload, with documented assumptions.

**AT-013 — Existing Feature Preservation**

Existing multi-service deployment, controlled database attachment, rollback, monitoring, notifications, AI troubleshooting, Terraform export, and billing functionality shall remain compatible after the architectural extensions.

**AT-014 — Customer Account Isolation**

Two simulated customer identities shall be unable to access or mutate each other's projects, AWS bindings, credentials, resources, monitoring, or operational evidence.

Real cross-account deployment certification shall require separately authorized test AWS accounts and shall not be inferred from local simulations.

**AT-015 — Hosting Profile Verification**

Each new hosting profile shall pass deployment, application-health, rollback or recovery, cost, ownership, and safe-cleanup checks before being marked available.

Failed or unverified profiles shall remain disabled for customer deployment.

---

## 9. Amend Section 12 — R1 Completion Criteria

R1 commercial readiness requires:

- Verified individual and team onboarding.
- Secure customer AWS authorization and tenant isolation.
- Preserved existing deployment, monitoring, troubleshooting, database, billing, and operational capabilities.
- The ECS Fargate deployment path with authoritative execution and health evidence.
- At least one independently verified budget-oriented compute deployment path.
- Transparent comparison against other eligible hosting options.
- Pre-deployment cost estimates and approval.
- A functioning Intelligence Harness built around existing adapters.
- Validated prompt-to-plan interaction.
- Correct release and resource ownership evidence.
- Safe rollback, cleanup, and operational monitoring.

Uncertified hosting profiles shall remain clearly unavailable and shall not block the safe operation of already verified profiles.

---

## 10. Replace Section 16 — Implementation Priority

This sequence shall build on the audited platform rather than restart development.

| Stage | Deliverable | Current interpretation |
|---|---|---|
| 1 | M0 lifecycle stabilization | Locally verified; preserve |
| 2 | S02 customer AWS binding and tenant ownership | Partially implemented; complete |
| 3 | Targeted session, TLS, health, retention, and cost fixes | Repair known defects |
| 4 | Unified DeploymentPlan contract using existing services | Extend rather than rewrite |
| 5 | Cost-aware hosting eligibility and comparative pricing | New core value |
| 6 | First budget-oriented deployment profile | Extend Terraform/Actions |
| 7 | Additional profiles: EC2, Lightsail, static, Lambda as applicable | Incremental, independently gated |
| 8 | Intelligence Harness integration | Reuse existing analysis and tools |
| 9 | Natural-language planning and approvals | Extend existing AI integration |
| 10 | Customer-scoped monitoring and operational evidence | Extend CloudWatch/Grafana/export |
| 11 | End-to-end customer workflow verification | Authorized local and AWS validation |
| 12 | Organization billing and enhanced operational intelligence | Preserve Stripe and existing billing |
| 13 | Governed remediation and supervised repair | Future extension |

### Implementation Rules

- No new engineering framework or requirements file is needed.
- No existing capability shall be removed solely because it was absent from the previous PRD.
- Existing M0 certification shall remain accepted unless subsequent changes invalidate its evidence.
- Actual codebase status shall determine what is implemented, partially implemented, or missing.
- Approved product requirements shall determine the intended target behavior.
- Existing implementations shall be reused wherever safe and compatible.
- New compute support shall not require a rewrite of the existing ECS deployment path.
- Do not migrate to microservices.
- No unapproved live AWS operations, push, merge, or destructive changes.

---

## 11. Amend Section 17 — Requirements Governance

The approved PRD v1.1 remains the authoritative product baseline.

Record the following targeted corrections in its existing change history:

1. Recognition and preservation of the audited DeployGuard platform.
2. Individual users added explicitly alongside team and agency customers.
3. Existing multi-service, database attachment, monitoring, AI troubleshooting, billing, and export capabilities protected from unnecessary replacement.
4. Existing Gemini and Stripe integrations retained.
5. React/Vite JavaScript accurately documented.
6. Budget-aware AWS hosting expanded beyond ECS Fargate.
7. EC2, Lightsail, Lambda, and static hosting introduced as independently gated profiles.
8. Customer-owned AWS account architecture clarified.
9. Security, application-health, audit-retention, and pricing defects added to repair priorities.
10. Implementation roadmap reconciled to actual verified progress.

The corrected requirements shall not be interpreted as authorization for live AWS spending or destructive cloud operations.

**End of targeted corrections.**
