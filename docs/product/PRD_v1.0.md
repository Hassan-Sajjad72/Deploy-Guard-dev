# DEPLOYGUARD
# Product Requirements Specification — Version 1.0

**Document type:** Business Requirements Document (BRD) and Product Requirements Document (PRD)  
**Date:** 10 October 2026  
**Product:** DeployGuard  
**Industry:** Software / IT — Cloud Infrastructure and Platform Engineering  
**Product model:** Business-to-business Software as a Service (B2B SaaS)  
**Status:** HISTORICAL — superseded by founder-approved [PRD v1.1](PRD_v1.1.md) on 10 October 2026  
**Purpose:** Define the complete product scope, functional requirements, system behavior, technical constraints, acceptance criteria, and release boundaries.

---

## 1. Executive Summary

DeployGuard is an intelligent AWS delivery and operations platform designed for software agencies, DevOps service providers, and AWS consultancies managing applications for multiple clients.

The platform combines application analysis, AI-assisted requirement interpretation, infrastructure planning, secure deployment, operational monitoring, cost visibility, recovery, and client delivery evidence into a unified system.

DeployGuard shall provide a single workflow through which engineering teams can:

1. Connect a client's GitHub repository.
2. Identify application requirements and deployment constraints.
3. Generate an explainable AWS deployment plan.
4. Review infrastructure, configuration, security, and expected costs.
5. Approve and deploy the application.
6. Verify its operational state.
7. Monitor deployments, errors, and costs.
8. Recover from failed releases.
9. Produce an auditable client handoff.

The product shall use existing cloud services and selected open-source technologies rather than replacing AWS or developing an independent cloud execution engine.

### Product positioning

**DeployGuard is an intelligent AWS delivery and operations control plane that helps software agencies deploy, manage, and hand over client applications with verified infrastructure, transparent costs, and operational accountability.**

### Product philosophy

- Intelligence must improve engineering decisions, not introduce uncontrolled infrastructure changes.
- Customers must understand what DeployGuard recommends, provisions, and charges.
- Production status must be backed by verified infrastructure evidence.
- Application ownership, access control, and recovery must remain transparent.
- The platform must reuse existing, reliable open-source and AWS capabilities.
- Technical complexity is justified only when it directly supports customer value, reliability, or security.

---

## 2. Business Problem

Software agencies and engineering teams frequently manage application delivery using disconnected tools and manual processes.

These processes include repository assessment, framework identification, environment configuration, infrastructure provisioning, CI/CD setup, security scanning, AWS deployment, operational monitoring, cost investigation, and client handoff.

### Problems experienced by the target customers

**BR-001 — Fragmented application delivery**

Engineering teams must coordinate several systems to deliver one application, increasing handoff effort and reducing operational visibility.

**BR-002 — Unclear application requirements**

Infrastructure decisions are often made before application dependencies, runtime configuration, external services, and deployment restrictions are fully understood.

**BR-003 — Deployment configuration overhead**

Teams repeatedly create similar infrastructure and CI/CD configurations for different client applications.

**BR-004 — Limited cost transparency**

Infrastructure costs are not always visible to engineers before resources are provisioned, and fixed networking or supporting-service costs can be overlooked.

**BR-005 — Inconsistent deployment verification**

A successful build or pipeline execution does not necessarily mean an application is available and functioning correctly.

**BR-006 — Difficult operational diagnosis**

Engineers must correlate logs, AWS service states, deployment changes, and application health to investigate incidents.

**BR-007 — Unsafe or incomplete cleanup**

Removing an application requires accurate resource ownership and verification that project-specific resources have actually been removed.

**BR-008 — Weak client handoff**

Clients may receive a working deployment without complete information about infrastructure ownership, application versions, access boundaries, costs, monitoring, and recovery.

**BR-009 — Limited reuse of engineering knowledge**

Agencies repeatedly solve deployment and operational problems without a consistent source of project-specific evidence.

### Business opportunity

DeployGuard shall reduce the engineering effort required to move from an authorized client repository to a verifiable AWS delivery and maintain an understandable operational record afterwards.

---

## 3. Business Objectives

**BO-001:** Reduce manual steps in delivering supported applications to AWS.

**BO-002:** Reduce configuration uncertainty through evidence-based application analysis.

**BO-003:** Provide infrastructure choices and cost estimates before provisioning.

**BO-004:** Establish a consistent, verifiable deployment and rollback process.

**BO-005:** Give agencies a unified view of client applications and AWS ownership.

**BO-006:** Improve incident investigation through correlated deployment and runtime evidence.

**BO-007:** Make client handoff reproducible and auditable.

**BO-008:** Establish a repeatable B2B product that agencies can purchase for client-delivery operations.

Business performance shall be validated through measured customer workflows, not unverified efficiency or savings claims.

---

## 4. Target Market and Users

### 4.1 Primary customer

Small and medium-sized software development agencies, DevOps consultancies, and AWS service providers responsible for deploying and maintaining applications on behalf of external clients.

### 4.2 Primary buyer

An agency founder, technical director, engineering manager, or DevOps lead responsible for delivery quality and operational cost.

### 4.3 Primary daily user

An engineer or DevOps practitioner responsible for application analysis, configuration, deployment, monitoring, and recovery.

### 4.4 Secondary users

- Agency administrator
- Deployment approver
- Client stakeholder
- Read-only auditor
- DeployGuard platform operator

### 4.5 Market boundaries

The initial product shall target teams deploying web applications and HTTP APIs to AWS.

The initial product shall not target general-purpose enterprise cloud management, multi-cloud migration, Kubernetes platform administration, or arbitrary infrastructure automation.

---

## 5. Product Release Strategy

DeployGuard shall use three clearly separated release scopes.

### Release R1 — Intelligent AWS Client Delivery

**Primary objective:** Deliver the complete repository-to-verified-AWS-to-client-handoff workflow.

R1 includes:

- GitHub authentication and repository integration
- Agency, client, and project workspaces
- Application and requirement discovery
- Intelligence Harness
- Natural-language deployment planning
- Validated deployment plans
- Infrastructure and cost review
- Existing ECS Fargate deployment integration
- Static web hosting
- Deployment verification
- Monitoring and deployment history
- Manual redeployment and verified rollback
- Safe resource cleanup
- Audited approvals
- Agency dashboard
- Client delivery evidence and handoff reports
- Essential platform administration

R1 is a controlled commercial pilot release. Customer production use requires passing the cloud and security certification gates.

### Release R2 — Commercial SaaS Administration and Operations

R2 includes:

- Subscription and entitlement management
- B2B invoicing and payment reconciliation
- Organization and seat limits
- Usage metering
- Advanced operator and super-admin controls
- Client portfolio reporting
- Operational cost trends
- Rightsizing recommendations
- Incident investigation
- API reliability assurance

R2 shall use invoice-based B2B billing rather than require a card-processing integration. Automated online checkout is excluded from the frozen release scope.

### Release R3 — Governed Self-Healing

R3 includes:

- Verified remediation runbooks
- Policy-based recovery recommendations
- Bounded automated operational recovery
- Post-remediation verification
- Incident learning and runbook evaluation
- Supervised source-code repair through pull requests

R3 shall not support unrestricted autonomous production code modifications or arbitrary AI-generated cloud commands.

**Release rule:** R1 must deliver a complete usable customer journey before R2 and R3 expand the product.

---

## 6. Fixed Technology Architecture

### 6.1 Application architecture

DeployGuard shall retain the existing modular monolithic architecture.

| Component | Required technology |
|---|---|
| Frontend | React and TypeScript |
| Backend | NestJS and TypeScript |
| Database | PostgreSQL |
| Source repository integration | GitHub |
| CI/CD execution | GitHub Actions |
| Container builds | Pinned Railpack and validated Dockerfile support |
| Infrastructure provisioning | Terraform |
| Container registry | Amazon ECR |
| Container hosting | Amazon ECS Fargate |
| Static hosting | Amazon S3 and CloudFront |
| Infrastructure evidence storage | Amazon S3 |
| Monitoring | Amazon CloudWatch |
| Infrastructure cost estimation | Infracost and approved AWS pricing data |
| Vulnerability scanning | Trivy |
| AI interface | Amazon Bedrock Converse API |
| Identity | Existing GitHub OAuth foundation |
| Infrastructure authorization | AWS IAM and GitHub OIDC |

### 6.2 Architecture restrictions

**AR-001:** NestJS shall remain the authoritative backend and orchestration control plane.

**AR-002:** The system shall not be migrated to microservices in R1–R3.

**AR-003:** The system shall maintain one versioned Deployment Plan contract across analysis, approval, build, infrastructure, deployment, and UI status.

**AR-004:** AI shall not directly execute arbitrary shell commands, Terraform changes, or AWS mutations.

**AR-005:** GitHub Actions and Terraform shall remain the established execution foundation.

**AR-006:** Existing deployment functionality shall not be rewritten solely to introduce an additional framework.

**AR-007:** Dependencies shall be introduced only for an explicitly specified product requirement with documented integration and maintenance costs.

**AR-008:** Existing working project branches shall remain protected during development.

---

## 7. Core Domain Model

DeployGuard shall implement the following business objects.

| Object | Definition |
|---|---|
| Organization | Software agency or company using DeployGuard |
| Membership | User identity, organization and assigned role |
| Client | External customer served by an organization |
| Engagement | A defined client delivery or operations engagement |
| AWS Account Binding | Verified AWS account and authorization associated with a client |
| Project | A deployable application owned by an engagement |
| Environment | Isolated development, staging or production configuration |
| Repository Snapshot | Repository identity and immutable source commit |
| Service Analysis | Evidence about application type, runtime and requirements |
| Deployment Plan | Validated, versioned deployment specification |
| Plan Approval | Authorized decision to execute an exact plan |
| Deployment Operation | Idempotent execution record for a requested action |
| Release | Immutable deployment artifact and runtime identity |
| Infrastructure Resource | AWS resource with proven project/environment ownership |
| Cost Estimate | Versioned infrastructure cost calculation |
| Health Observation | Timestamped application or infrastructure health evidence |
| Incident | Recorded operational problem and associated evidence |
| Recovery Action | Authorized, bounded remediation attempt |
| Audit Event | Immutable record of a security-relevant or operational action |
| Handoff Package | Sanitized, exportable client delivery evidence |
| Commercial Account | Customer billing and entitlement state |

Every project must belong to exactly one engagement and one client. Every environment must belong to exactly one project.

A record shall not cross organization or client boundaries without a specifically authorized sharing mechanism.

---

# 8. Functional Requirements — R1

## Module 1: Authentication and Access Control

**FR-001:** Users shall authenticate using GitHub OAuth.

**FR-002:** DeployGuard shall create or associate a platform user only after successful identity verification.

**FR-003:** A user shall be able to belong to multiple organizations with separate memberships.

**FR-004:** R1 shall support these organization roles:

- Owner
- Administrator
- Engineer
- Approver
- Viewer

**FR-005:** Owners and administrators shall manage memberships, clients and projects within their organization.

**FR-006:** Engineers shall analyze repositories, prepare deployment plans and request deployment approval.

**FR-007:** Approvers shall approve or reject deployment, rollback and cleanup operations within their assigned organization and environment scope.

**FR-008:** Viewers shall have read-only access to explicitly authorized project information.

**FR-009:** Deployment authorization shall be enforced by backend APIs and background operations, not only frontend controls.

**FR-010:** Revoked GitHub access or removed organization membership shall prevent new unauthorized operations.

**FR-011:** User sessions shall support server-side revocation.

**FR-012:** All privileged decisions shall produce auditable records.

**Acceptance:** Unauthorized users cannot view another organization's repositories, environments, costs, releases, infrastructure identifiers or operation history.

## Module 2: Agency and Client Management

**FR-013:** An organization owner shall create an agency workspace.

**FR-014:** Authorized members shall create and manage client records.

**FR-015:** Each client shall have a unique ID, name, lifecycle status, project list, environment list and AWS account ownership information.

**FR-016:** An organization shall create engagements under a client.

**FR-017:** An engagement shall group the client's related projects and operational records.

**FR-018:** An authorized user shall create a project by selecting an engagement and connecting a GitHub repository.

**FR-019:** The portfolio dashboard shall display project name, client, environment, deployment state, latest verified release, and operational alerts.

**FR-020:** Archived clients and engagements shall retain audit history and shall not automatically delete running cloud infrastructure.

**Acceptance:** A project created for Client A never appears in Client B's workspace, API responses, search results, or exported reports.

## Module 3: AWS Account Connection and Ownership

**FR-021:** The platform shall distinguish the DeployGuard control-plane account from customer workload accounts.

**FR-022:** The R1 commercial architecture shall use customer-controlled AWS accounts through scoped cross-account access.

**FR-023:** A client AWS account connection shall verify account identity, authorized role, region and required permissions before it becomes usable.

**FR-024:** Production client workloads shall not be silently deployed into DeployGuard's shared control-plane AWS account.

**FR-025:** AWS access shall use temporary role-based credentials, not customer access keys stored as permanent application secrets.

**FR-026:** Infrastructure state and resource ownership shall be separated by client, project and environment.

**FR-027:** DeployGuard shall record AWS account ID, region, role identity, project ownership, environment identity and provisioned resource identifiers.

**FR-028:** A revoked or invalid AWS connection shall block new provisioning and mutation, while preserving records of existing customer resources.

**FR-029:** The initial certified AWS deployment region shall be `us-east-1`. Other regions shall be rejected as unsupported until separately certified.

**FR-030:** IAM policies shall grant only the operations required by the approved deployment and verification workflows.

**Acceptance:** Requests to create, modify, inspect beyond authorization, or delete another client's AWS resources are denied.

## Module 4: GitHub Integration and Repository Analysis

**FR-031:** A user shall connect repositories permitted by their GitHub authorization.

**FR-032:** The repository picker shall display only repositories accessible to the authenticated user and approved integration.

**FR-033:** Users shall select a repository and branch before analysis.

**FR-034:** DeployGuard shall resolve the selected source to an immutable Git commit SHA.

**FR-035:** All analysis and build decisions for one operation shall use that exact source SHA.

**FR-036:** The repository analyzer shall determine:

- Primary language
- Framework
- Application type
- Deployable directory
- Package manager
- Manifest and lockfile
- Build and start requirements
- HTTP port requirements
- Relevant workspace structure
- External dependency indicators

**FR-037:** Repository inspection shall not execute untrusted source code.

**FR-038:** Repository traversal shall reject unsafe file paths, symlink escapes and configured resource-limit violations.

**FR-039:** Unsupported or ambiguous repositories shall produce a specific explanation and a blocked readiness state.

**FR-040:** Analysis results shall record the analyzer version, source SHA, evidence source and timestamp.

**Initial application compatibility:**

- Node.js standalone HTTP services: supported ECS target.
- Python standalone HTTP services: supported ECS target.
- React/Vite proven static applications: supported S3/CloudFront target.
- Nested project directories: supported through explicit selection.
- Monorepositories: analysis and one selected deployable application supported.
- Multi-service simultaneous deployment: not supported in R1.
- Next.js SSR, Kubernetes workloads and worker-only applications: not supported in R1.

Compatibility is advertised as certified only after the relevant build and live-provider tests pass.

**Acceptance:** Analysis of a source SHA is reproducible and does not silently change when the branch advances.

## Module 5: Configuration and Dependency Intelligence

**FR-041:** DeployGuard shall identify configuration requirements using documented repository evidence.

**FR-042:** The analyzer shall inspect safe configuration templates and manifests, including `.env.example` and relevant framework configuration files.

**FR-043:** Each configuration requirement shall include:

- Variable name
- Required or optional classification
- Build-time or runtime scope
- Secret or non-secret classification
- Source evidence
- Resolution status

**FR-044:** The system shall detect missing required variables.

**FR-045:** The system shall identify likely external dependencies such as databases, caches, object storage and queues.

**FR-046:** A detected dependency shall not automatically trigger provisioning of a new AWS service.

**FR-047:** Users shall explicitly provide or select the connection configuration for supported external services.

**FR-048:** Secret values shall be securely stored and referenced without inclusion in logs, prompts, plan JSON, user-visible reports or static frontend bundles.

**FR-049:** Environment configuration changes shall invalidate affected deployment-plan approvals.

**FR-050:** The system shall identify conflicting platform-controlled keys such as the application port and host binding.

**Acceptance:** Deployment cannot proceed when a verified mandatory configuration requirement remains unresolved.

## Module 6: Intelligence Harness

The Intelligence Harness shall be the central application-analysis and decision-support component.

It shall be implemented inside the existing NestJS backend.

### Harness responsibilities

**FR-051 — Context collection**

The Harness shall collect and correlate:

- Immutable repository analysis
- Build information
- Configuration requirements
- External dependencies
- Supported AWS deployment capabilities
- Security findings
- Cost-estimation inputs
- Existing deployment history
- Applicable project policies

**FR-052 — Evidence provenance**

Every consequential analysis finding shall include a traceable source, analyzer or provider version, timestamp and confidence classification.

**FR-053 — Build readiness**

The Harness shall determine whether the application satisfies a supported build and runtime contract.

**FR-054 — Infrastructure eligibility**

The Harness shall eliminate AWS deployment profiles that cannot satisfy the application's hard requirements.

**FR-055 — Resource assumptions**

The Harness shall produce initial CPU, memory and scaling assumptions based on known runtime requirements and user-provided workload constraints.

Source inspection alone shall not be represented as measured production resource consumption.

**FR-056 — Cost analysis**

The Harness shall calculate itemized, region-specific estimates for eligible deployment plans using approved pricing data and Infracost where applicable.

**FR-057 — Risk analysis**

The Harness shall include relevant vulnerability findings, configuration issues, missing permissions and unsupported infrastructure requirements.

**FR-058 — Recommendations**

The Harness shall explain the recommended eligible deployment profile, assumptions, cost breakdown, trade-offs and rejected alternatives.

**FR-059 — No fabricated compatibility**

If no certified profile meets the requirements, the Harness shall return `NO_ELIGIBLE_PROFILE`.

**FR-060 — Reproducibility**

Identical analysis inputs, versions and pricing snapshots shall produce equivalent deterministic results.

**FR-061 — Persistence**

Harness findings and recommendations shall be stored with a source SHA, analysis ID, version, evidence references and expiration/invalidation conditions.

**FR-062 — Non-mutating operation**

The Harness shall not provision AWS resources while performing analysis or recommendation.

**Acceptance:** A recommended architecture can be traced to actual application evidence, supported infrastructure capabilities and explicit cost assumptions.

## Module 7: AI and Natural-Language Interaction

**FR-063:** DeployGuard shall provide a natural-language interface for deployment and AWS operations planning.

**FR-064:** R1 AI inference shall use Amazon Bedrock through a controlled backend adapter.

**FR-065:** The approved runtime model identifier shall be pinned in deployment configuration and verified for the supported AWS region before AI is enabled.

**FR-066:** AI shall receive sanitized project context rather than unrestricted repository content, secret values or AWS credentials.

**FR-067:** Supported natural-language intentions shall be restricted to:

1. Analyze an application.
2. Explain application requirements.
3. Prepare a deployment plan.
4. Explain missing configuration.
5. Compare eligible infrastructure choices.
6. Explain estimated deployment costs.
7. Explain a deployment failure using available evidence.
8. Summarize application operational status.
9. Prepare a client delivery summary.

**FR-068:** Natural-language output shall be converted into validated, typed backend requests.

**FR-069:** The AI model shall not invent authoritative AWS resource IDs, costs, runtime states or permissions.

**FR-070:** Missing mandatory user constraints shall be requested explicitly.

**FR-071:** A deployment-related prompt shall generate a plan preview, not trigger immediate AWS execution.

**FR-072:** Users shall review the exact structured plan and provide a separate approval before deployment.

**FR-073:** AI service failures shall display an appropriate error and retain access to the deterministic analysis and guided deployment interface.

**FR-074:** All AI interactions shall be subject to request-size, frequency, provider-cost and timeout limits.

**FR-075:** Repository instructions, logs and user content shall be treated as untrusted data and shall not override DeployGuard execution policy.

**FR-076:** AI explanations shall distinguish observed evidence, inferred requirements and unresolved uncertainty.

**Acceptance:** A prompt requesting destructive AWS action cannot bypass role checks, approval requirements or established execution contracts.

### Natural-language workflow example

User input:

> Deploy my Node.js API from GitHub on AWS. Keep costs low and enable monitoring.

DeployGuard shall:

1. Identify the repository and immutable source commit.
2. Inspect application and configuration requirements.
3. Request missing traffic, region, environment or budget constraints.
4. Identify the eligible AWS deployment profile.
5. Display estimated infrastructure cost and security considerations.
6. Produce a structured deployment plan.
7. Wait for the user's explicit approval.
8. Execute through the existing deployment system.
9. Verify deployment health.
10. Present the deployment record.

## Module 8: Deployment Plan and Approval

**FR-077:** Every deployment shall use a validated, versioned Deployment Plan.

**FR-078:** The plan shall contain:

- Schema version
- Organization and client
- Project and environment
- Source repository and commit SHA
- Application classification
- Build contract and deployable directory
- Selected hosting profile
- Region and AWS account
- Resource configuration
- Required external services
- Non-secret configuration requirements
- Secret references
- Network requirements
- Health verification contract
- Estimated infrastructure costs
- Relevant security findings
- Plan fingerprint

**FR-079:** A plan shall be immutable after approval.

**FR-080:** A change to source, configuration, environment, hosting profile or resource configuration shall require a new plan version.

**FR-081:** Deployment authorization shall bind the actor, plan fingerprint, environment and intended operation.

**FR-082:** The UI shall clearly display whether a plan is analyzing, blocked, awaiting inputs, ready, approved, executing or completed.

**FR-083:** The system shall prevent execution of unsupported, stale or manipulated plans.

**FR-084:** The deployment preview shall show the expected resource changes before approval.

**FR-085:** The cost approval shall disclose fixed and variable cost components and mark unknown amounts.

**Acceptance:** An altered plan fingerprint or unauthorized actor cannot initiate deployment.

## Module 9: AWS Deployment Execution

**FR-086:** DeployGuard shall execute approved deployments through existing GitHub Actions and Terraform integration.

**FR-087:** Each deployment shall receive a globally unique operation identity.

**FR-088:** Workflow runs shall be correlated to the exact operation identity.

**FR-089:** The system shall not associate an unrelated GitHub workflow run with a deployment operation.

**FR-090:** Application build artifacts shall retain immutable source and image identities.

**FR-091:** Trivy shall scan applicable build artifacts before release according to the approved security policy.

**FR-092:** Deployment execution shall use only the authorized AWS account, region and project/environment resource scope.

**FR-093:** The system shall support explicit operation states: `PENDING`, `RUNNING`, `VERIFIED`, `FAILED`, `BLOCKED`, and `UNVERIFIED`.

**FR-094:** A successful workflow exit shall not independently establish application availability.

**FR-095:** The platform shall verify the expected runtime resource identities and application endpoint before declaring a release verified.

**FR-096:** Concurrent deployments for the same environment shall be serialized or rejected through an explicit operation lock.

**FR-097:** Interrupted or ambiguous operations shall remain recoverable without unsafe duplicate resource creation.

**FR-098:** A failed release shall preserve the last verified healthy release where technically possible.

**FR-099:** The user interface shall show operation progress, relevant errors and verifiable results.

**FR-100:** Existing project deployment and rollback contracts shall remain compatible through explicitly versioned migrations.

**Acceptance:** Users cannot receive a false `LIVE` or successful deployment status solely because GitHub Actions reported success.

## Module 10: Static Application Hosting

**FR-101:** Proven static applications shall be eligible for the S3/CloudFront hosting profile.

**FR-102:** Static assets shall be stored in private S3 buckets or project-isolated private prefixes.

**FR-103:** CloudFront shall serve application assets over HTTPS using approved access controls.

**FR-104:** Runtime-dependent applications, APIs and server-rendered applications shall be rejected from the static profile.

**FR-105:** The system shall record the exact deployed static artifact version.

**FR-106:** Static releases shall support verification, redeployment and rollback to a recorded prior version.

**FR-107:** Cleanup shall protect shared distribution, domain, certificate and storage resources that do not belong exclusively to the project.

**Acceptance:** The deployment system shall not report an API or SSR application as successfully deployed through static hosting.

## Module 11: Monitoring and Operational Visibility

**FR-108:** The platform shall display the latest verified application deployment state.

**FR-109:** The dashboard shall provide ECS service health, task state, deployment events and configured endpoint availability.

**FR-110:** The dashboard shall display available CloudWatch metrics for the selected project and environment.

**FR-111:** The platform shall correlate operational observations with their deployment and release identities.

**FR-112:** Users shall access recent deployment failures, relevant sanitized logs and alert history.

**FR-113:** Health readings shall include timestamps and observation status.

**FR-114:** Missing monitoring permissions or metrics shall be shown as unavailable rather than interpreted as healthy.

**FR-115:** Significant deployment failures shall generate in-app notifications.

**FR-116:** The platform shall maintain a release timeline showing source SHA, change actor, execution status and verification evidence.

**Acceptance:** An unavailable or unhealthy application must not appear healthy because of a stale successful deployment record.

## Module 12: Cost Intelligence

**FR-117:** DeployGuard shall estimate the monthly cost of an eligible architecture before provisioning.

**FR-118:** Estimates shall include applicable compute, storage, load-balancing, networking, logging and supporting AWS resource costs.

**FR-119:** Cost estimates shall contain pricing source, region, currency, timestamp and workload assumptions.

**FR-120:** Estimates shall explicitly separate the customer's AWS charges from any DeployGuard platform fee.

**FR-121:** Users shall provide a maximum acceptable estimated monthly infrastructure budget before approving new resource provisioning.

**FR-122:** Plans exceeding that budget shall be rejected until a revised plan is approved.

**FR-123:** The system shall not claim an architecture is the cheapest unless eligible alternatives have comparable cost coverage.

**FR-124:** When pricing data is incomplete, the estimate shall show `ESTIMATE_INCOMPLETE` and shall not claim cost optimization.

**FR-125:** Actual AWS charges shall be displayed only when authorized billing data is available and sufficiently scoped to the relevant account or resources.

**Acceptance:** The cost engine must account for fixed infrastructure costs where relevant, including load balancers and network components. Missing prices shall not be silently treated as zero.

## Module 13: Verified Release, Rollback and Resource Cleanup

**FR-126:** DeployGuard shall maintain immutable records of successfully verified releases.

**FR-127:** An authorized user shall be able to request a rollback to an identified previous verified release.

**FR-128:** Rollback shall use the recorded release artifact, not a newly built image from a moving branch.

**FR-129:** Rollback success shall require runtime and endpoint verification.

**FR-130:** The latest healthy release pointer shall not be replaced by a failed or unverified release.

**FR-131:** Resource deletion shall require an exact project/environment ownership manifest.

**FR-132:** Deletion shall verify resource absence using independent AWS observations appropriate to each resource type.

**FR-133:** A Terraform success response alone shall not establish that all owned AWS resources have been removed.

**FR-134:** Missing, conflicting, corrupt or incomplete ownership evidence shall block destructive cleanup.

**FR-135:** Cleanup shall not delete shared resources, unrelated environments or protected persistent customer data.

**FR-136:** Partial deletion shall remain visible as an incomplete operation with a safely recoverable retry process.

**FR-137:** Existing historical deployments lacking sufficient ownership evidence shall use an authorized manual reconciliation process rather than an unsafe guessed resource scope.

**FR-138:** Customer resources shall not be deleted automatically when a user account is blocked, a subscription expires or an organization is suspended.

**Acceptance:** Resource cleanup cannot be reported as verified until the exact owned resource scope has passed the approved absence checks.

## Module 14: Client Handoff and Delivery Evidence

**FR-139:** DeployGuard shall generate a client delivery record for an authorized engagement and environment.

**FR-140:** The report shall identify:

- Client and engagement
- Application name and source commit
- Deployed version and artifact identities
- AWS account and region
- Infrastructure architecture
- Project-owned resource inventory
- Configuration requirement names
- Verified endpoint and deployment status
- Monitoring configuration and health evidence
- Cost estimate and assumptions
- Security scan summary
- Deployment and rollback history
- Operational limitations and outstanding issues
- Responsible agency and approval history

**FR-141:** The handoff shall be available in a human-readable PDF and a structured JSON export.

**FR-142:** Handoff exports shall exclude credentials, raw secrets and unauthorized client information.

**FR-143:** Reports shall contain generation timestamps and evidence references.

**FR-144:** A release without required live AWS verification shall display that verification gap explicitly.

**FR-145:** Only authorized organization members and explicitly authorized client viewers shall access a handoff.

**Acceptance:** An engineer can produce a report from stored deployment evidence without manually reconstructing the AWS configuration from unrelated systems.

## Module 15: Essential Administration

**FR-146:** The agency owner shall manage organization memberships, clients, projects and access restrictions.

**FR-147:** DeployGuard shall provide a logically separate internal platform administration interface.

**FR-148:** Internal operators shall not automatically inherit access to customer AWS credentials or resource-mutation permissions.

**FR-149:** Privileged platform actions shall require authenticated, authorized users and audit logging.

**FR-150:** The platform shall permit an authorized operator to restrict a compromised account without automatically affecting existing customer workloads.

**FR-151:** Essential admin views shall display organizations, user status, project status and platform operation failures.

**FR-152:** Privileged identity changes shall include actor, timestamp and reason.

**Acceptance:** Platform administration and agency administration remain separate authorization domains.

---

# 9. Functional Requirements — R2

## Module 16: Commercial SaaS Management

**FR-153:** DeployGuard shall maintain versioned subscription plans and organization entitlements.

**FR-154:** Plans shall support measurable limits for members, clients, projects, concurrent operations, evidence retention and AI usage.

**FR-155:** Plan changes shall preserve historical commercial records.

**FR-156:** The platform shall meter billable events using immutable, idempotent usage records.

**FR-157:** R2 shall support B2B invoice creation, invoice status, due dates and externally settled payment reconciliation.

**FR-158:** Financial records shall distinguish DeployGuard subscription charges from AWS infrastructure expenses.

**FR-159:** Authorized billing operators shall record payment reconciliation, adjustments and disputes with audit trails.

**FR-160:** Subscription cancellation or overdue invoices shall restrict new billable platform operations according to the customer's agreement, without deleting their AWS infrastructure.

**FR-161:** Organization administrators shall view plan, entitlement, invoice and usage information.

**FR-162:** Subscription transitions shall prevent duplicate charges or double-counted usage.

## Module 17: Expanded Platform Administration

**FR-163:** The internal administration console shall support separate super-admin, operations, support, billing and security-auditor roles.

**FR-164:** Administrators shall search organizations, users, projects and operations within their permitted scope.

**FR-165:** Suspensions, reinstatements and changes to plan entitlements shall require recorded reasons.

**FR-166:** Sensitive administrative actions shall require additional authentication or independently approved privileged authorization.

**FR-167:** Support access to customer information shall be time-limited, purpose-bound and audited.

**FR-168:** All administrative actions shall preserve customer AWS ownership and operational evidence.

## Module 18: Incident Intelligence and API Assurance

**FR-169:** DeployGuard shall correlate runtime failures with release changes, metrics, logs and AWS events.

**FR-170:** Incident explanations shall distinguish verified facts, suspected causes and missing evidence.

**FR-171:** The platform shall support read-only AI-assisted incident analysis.

**FR-172:** Supported HTTP API projects shall register a documented health endpoint and available OpenAPI contract.

**FR-173:** API contract regression tests shall execute only against approved test or staging targets.

**FR-174:** Regression results shall be retained with the associated source, endpoint, contract and environment identity.

**FR-175:** Incident diagnosis shall provide recommended next steps without granting the AI direct mutation authority.

## Module 19: Operational Optimization

**FR-176:** DeployGuard shall compare current infrastructure configuration against available usage and performance evidence.

**FR-177:** The system shall recommend resource-size or replica-count changes only when adequate workload observations exist.

**FR-178:** Every optimization recommendation shall include the observed data window, assumptions, expected cost effect and reliability trade-offs.

**FR-179:** Optimization proposals shall require an approved plan change before application.

**FR-180:** A failed optimization change shall retain or restore the previous verified configuration.

---

# 10. Functional Requirements — R3

## Module 20: Governed Self-Healing

**FR-181:** DeployGuard shall maintain a versioned registry of approved operational runbooks.

**FR-182:** The first supported recovery actions shall be:

- Rollback to a verified previous release.
- Retry a failed deployment through its existing idempotent contract.
- Restart a specified unhealthy ECS service through a validated AWS operation.
- Adjust ECS replica count within preapproved resource and cost limits.

**FR-183:** Every recovery operation shall require verified incident context, resource ownership and authorization.

**FR-184:** The remediation system shall verify that required preconditions remain true immediately before execution.

**FR-185:** Production mutation shall require an authorized approval or a separately approved bounded automation policy.

**FR-186:** Recovery operations shall enforce execution locks, retry limits, budgets, timeouts and permitted AWS resource identities.

**FR-187:** After execution, DeployGuard shall check application and infrastructure health against recorded success conditions.

**FR-188:** An unsuccessful recovery shall remain recorded as failed and shall not be presented as a resolved incident.

**FR-189:** Automated remediation shall not perform arbitrary shell execution, privilege escalation or resource deletion.

**FR-190:** The platform shall store complete authorization, action, result and verification evidence for each remediation.

## Module 21: Supervised Application Repair

**FR-191:** The platform shall identify source-code defects only when an incident has sufficient reproducible evidence for a bounded repair attempt.

**FR-192:** The repair system shall work in a sandboxed environment without customer production credentials.

**FR-193:** Generated code changes shall be submitted as a reviewable GitHub pull request.

**FR-194:** Generated repairs shall undergo the project's relevant automated tests and API contract verification.

**FR-195:** The system shall report exactly which tests passed, failed or could not run.

**FR-196:** AI-generated patches shall not be merged automatically into protected production branches.

**FR-197:** Production release of repaired code shall use the same authorized deployment and verification workflow as ordinary code changes.

**FR-198:** A repair attempt shall be considered successful only after independently verified application recovery.

---

# 11. Intelligence Harness Internal Requirements

The Harness shall consist of six logically separated components within the NestJS backend.

### IH-001 — Context Engine

Gather project-specific evidence from repositories, application configuration, AWS resources, operation history, cost information and available telemetry.

### IH-002 — Specialist Adapter Layer

Integrate established external capabilities through explicit, versioned adapters.

R1 adapters:

- Railpack
- Trivy
- Infracost
- Terraform
- GitHub Actions
- AWS ECS and related AWS APIs

R2 adapters:

- OpenTelemetry-supported telemetry ingestion
- Schemathesis API testing
- Read-only incident analysis based on collected evidence

R3 adapters:

- Policy evaluation for remediation
- Approved remediation runbooks
- Sandboxed source-code repair

### IH-003 — AI Reasoning Interface

Use Amazon Bedrock to interpret authorized natural-language requests and explain verified evidence.

AI output shall be treated as a proposal until schema and policy validation succeeds.

### IH-004 — Deterministic Decision Engine

Evaluate deployment eligibility, hard constraints, pricing coverage, runtime requirements, and available architecture profiles.

### IH-005 — Execution Gateway

Accept only an approved structured operation with valid identity, permissions, plan fingerprint and resource scope.

### IH-006 — Evaluation Engine

Measure the Harness against fixed test fixtures covering:

- Correct application classification
- Unsupported workload rejection
- Missing configuration identification
- Valid cost calculations
- Invalid cost claims
- Prompt injection resistance
- Missing AWS permissions
- Unauthorized mutation requests
- Stale source SHA
- Conflicting deployment requirements
- Incomplete resource ownership evidence

The Harness shall not be declared release-ready solely because its AI explanations appear convincing.

---

# 12. User Experience Requirements

DeployGuard shall provide one unified agency-facing web application.

### Required screens

**UX-001:** Login and account onboarding  
**UX-002:** Organization selection and agency dashboard  
**UX-003:** Client and engagement management  
**UX-004:** Project creation and GitHub repository selection  
**UX-005:** Application analysis and dependency review  
**UX-006:** Intelligence Harness findings  
**UX-007:** Natural-language planning interface  
**UX-008:** Infrastructure architecture and cost preview  
**UX-009:** Environment configuration and secrets  
**UX-010:** Deployment plan approval  
**UX-011:** Live deployment progress  
**UX-012:** Application status and health monitoring  
**UX-013:** Release history and rollback  
**UX-014:** Infrastructure ownership and resource inventory  
**UX-015:** Resource cleanup and confirmation  
**UX-016:** Client handoff and evidence export  
**UX-017:** Organization settings and team permissions  
**UX-018:** Internal platform administration  

R2 adds subscription, invoicing, incident and optimization views.

R3 adds remediation approval, execution history and supervised repair views.

### Interface requirements

**UX-019:** Every operation shall show a truthful state, including loading, success, failure, blocked and unverified outcomes.

**UX-020:** Error messages shall explain what failed and what action the user can take next.

**UX-021:** Prompt interaction shall supplement structured forms, not replace access to exact infrastructure settings.

**UX-022:** Users shall see the proposed AWS architecture before approving provisioning.

**UX-023:** The UI shall support desktop and mobile layouts and keyboard-accessible core workflows.

**UX-024:** A user shall not need to understand Terraform syntax to use supported deployment workflows.

---

# 13. Non-Functional Requirements

## 13.1 Security

**NFR-001:** Authorization shall be tenant-, client-, project-, environment- and action-scoped.

**NFR-002:** All external communications shall use HTTPS/TLS.

**NFR-003:** Sensitive credentials shall not be stored in plaintext.

**NFR-004:** AWS access shall use least-privilege roles and short-lived credentials.

**NFR-005:** Audit records shall include actor, resource, action, timestamp and outcome.

**NFR-006:** Destructive operations shall fail closed when resource ownership is uncertain.

**NFR-007:** AI context shall be sanitized and restricted to authorized data.

**NFR-008:** All externally supplied repository content shall be treated as untrusted input.

## 13.2 Reliability

**NFR-009:** User-visible success shall require authoritative operation evidence.

**NFR-010:** Deployment retries shall be idempotent.

**NFR-011:** Failure of a new deployment shall not silently overwrite a previously verified release.

**NFR-012:** Incomplete operations shall remain visible and recoverable.

**NFR-013:** R1 shall target 99.5% monthly availability of the DeployGuard control-plane service after production launch. This is an internal engineering objective, not an unconditional customer SLA.

## 13.3 Performance

**NFR-014:** Standard authenticated API requests shall target a p95 server response time below one second under the defined pilot test load.

**NFR-015:** Repository analysis shall target completion within two minutes for supported pilot fixtures of up to 200 MB and 5,000 tracked files, excluding externally unavailable dependencies.

**NFR-016:** Long-running build and deployment operations shall execute asynchronously and expose progress to the frontend.

**NFR-017:** The platform shall prevent unbounded repository scanning, analysis memory consumption and AI request execution.

## 13.4 Data retention and recovery

**NFR-018:** Repository checkout copies shall be temporary and removed after the operation's defined processing window, with a target maximum of one hour after completion.

**NFR-019:** Operational evidence shall be retained for at least 90 days for active pilot engagements.

**NFR-020:** Security and administrative audit evidence shall be retained for 365 days, subject to the platform's published retention obligations.

**NFR-021:** PostgreSQL backups shall be encrypted and tested for restore capability.

**NFR-022:** The initial internal metadata recovery targets shall be an RPO of 24 hours and RTO of 24 hours, with actual recovery demonstrated before production certification.

## 13.5 Maintainability

**NFR-023:** The architecture shall remain a modular NestJS monolith.

**NFR-024:** All cross-module contracts shall be typed and versioned.

**NFR-025:** Repository and infrastructure scanning logic shall not be duplicated across modules.

**NFR-026:** Changes shall preserve backward compatibility or introduce an explicitly approved versioned migration.

**NFR-027:** Code shall prioritize clarity and existing abstractions over speculative generalization.

**NFR-028:** Open-source integrations shall be pinned, license-reviewed, isolated behind adapters and tested for failure behavior.

## 13.6 Cost and operational controls

**NFR-029:** Cloud resource creation shall require an approved cost-bearing plan.

**NFR-030:** AWS budget notifications shall not be treated as hard spending limits.

**NFR-031:** Application-level limits shall restrict analysis concurrency, AI spending and repeated operations.

**NFR-032:** The initial AI usage policy shall limit each organization to 100 model-assisted requests and a tracked inference budget of USD 5 per day, unless an organization-specific higher limit is explicitly authorized.

**NFR-033:** Infrastructure experiments involving live AWS resources shall require an explicitly authorized account, region, maximum spend and cleanup window.

---

# 14. Complete Primary Customer Journey

The R1 user journey is mandatory and defines the central product acceptance case.

### Step 1 — Agency onboarding

An agency owner authenticates, creates an organization and creates a client engagement.

### Step 2 — AWS account connection

An authorized administrator connects the client's dedicated AWS account through the approved role mechanism.

DeployGuard validates the account and permitted region.

### Step 3 — Application selection

An engineer connects a GitHub repository and selects the target source revision and deployment environment.

### Step 4 — Application analysis

The Intelligence Harness identifies the supported application contract, runtime requirements, configuration and dependencies.

### Step 5 — Requirements collection

The system requests missing configuration, expected operating characteristics and a deployment budget.

### Step 6 — Deployment planning

The Harness generates a validated deployment plan using a certified infrastructure profile.

### Step 7 — Cost and security review

The user reviews expected AWS resources, cost assumptions, security findings and blocked conditions.

### Step 8 — Approval

An authorized approver confirms the exact deployment-plan fingerprint.

### Step 9 — Infrastructure provisioning

DeployGuard executes its established GitHub Actions and Terraform workflow through approved AWS permissions.

### Step 10 — Application release

The application artifact is built, scanned, published and released using an immutable source identity.

### Step 11 — Runtime verification

DeployGuard verifies the resource identity and accessible application endpoint.

### Step 12 — Monitoring

The dashboard displays verified release state, health observations, operational events and applicable cost information.

### Step 13 — Recovery

If a release fails, the user can investigate the error and request a verified rollback.

### Step 14 — Handoff

The agency generates a client delivery evidence package recording infrastructure, release, operational configuration and ownership.

### Step 15 — Lifecycle closure

When an engagement ends, the agency may request approved resource cleanup, with exact ownership verification and protection for shared or persistent resources.

**The customer journey is not complete if any critical step requires unsupported manual reconstruction of DeployGuard's deployment state.**

---

# 15. Acceptance and Certification Criteria

## 15.1 Application analysis

- Supported application fixtures produce correct classifications.
- Unsupported applications are rejected with actionable reasons.
- Missing configuration requirements are correctly reported.
- Repository SHA changes invalidate affected analyses.
- No secrets appear in analysis output.

## 15.2 Intelligence Harness

- Recommendations are consistent with supported deployment contracts.
- Cost estimates include their assumptions and known omissions.
- Invalid infrastructure candidates are excluded.
- Model failure does not bypass deterministic validation.
- Malicious prompt or repository content cannot authorize infrastructure operations.

## 15.3 Deployment

- A Node.js HTTP service deploys and passes public endpoint verification.
- A Python HTTP service deploys and passes public endpoint verification.
- A React/Vite static site deploys through private S3 and CloudFront and passes verification.
- Failed deployments retain the last verified release where applicable.
- Duplicate or ambiguous workflow dispatch does not create false success.
- Unauthorized AWS resource scope is rejected.

## 15.4 Recovery and cleanup

- Rollback selects the exact previous release.
- Cleanup rejects missing or conflicting resource ownership.
- Partial deletion is not marked successful.
- Shared resources are not deleted.
- Real AWS resource absence is independently confirmed before cleanup is certified.

## 15.5 Tenant security

- An organization cannot access another organization's data.
- An engineer cannot bypass an approver's authority.
- Read-only users cannot trigger mutation.
- Revoked permissions prevent new operations.
- AWS roles cannot operate on unauthorized client resource scopes.

## 15.6 User experience

- The entire primary customer journey is navigable from the web application.
- Every operation displays its real status.
- Missing information produces an actionable prompt or form.
- Cost and infrastructure details are visible before approval.
- Client handoff exports contain verifiable evidence and no secrets.

## 15.7 Production certification

Passing local unit, integration and browser tests shall not be considered proof of AWS production readiness.

A hosting profile shall require authorized real-provider testing covering provisioning, release, health, rollback, cleanup, permission boundaries and cost observations before being described as production-certified.

---

# 16. Engineering Implementation Requirements

The engineering team shall follow a controlled AI-assisted development workflow.

**ER-001:** The master PRD shall be the authoritative source of approved product requirements.

**ER-002:** Architecture and engineering workflow documents shall provide implementation guidance without contradicting the PRD.

**ER-003:** Codex shall use scoped engineering roles and specialized skills only when relevant.

**ER-004:** ECC shall support development and review procedures without overriding project requirements.

**ER-005:** Ponytail-style reviews shall identify unnecessary abstraction, duplication and complexity.

**ER-006:** AWS specialist tooling shall support AWS implementation reviews through authorized capabilities.

**ER-007:** Development tools shall not require additional external signups or API keys merely to participate in the local engineering workflow.

**ER-008:** Development shall prioritize complete vertical slices rather than unrelated partial modules.

**ER-009:** Focused tests shall run during implementation.

**ER-010:** Full automated regression shall run at meaningful integration and release boundaries, and again when subsequent changes invalidate earlier coverage.

**ER-011:** Security-critical changes shall receive their required targeted checks regardless of development-efficiency targets.

**ER-012:** Repeated investigation without measurable progress shall trigger root-cause reassessment rather than indefinite testing loops.

**ER-013:** A feature shall not be declared complete based only on code generation, successful compilation or a mocked user interface.

**ER-014:** Main engineering agents shall review and integrate delegated work.

**ER-015:** Publishing, production deployment and privileged AWS operations shall require explicit authorization.

---

# 17. Development Priority and Dependency Order

Implementation shall follow these dependencies:

| Stage | Primary delivery |
|---|---|
| 1 | Finish existing ECS lifecycle stabilization and strict ownership integration |
| 2 | Establish AWS authorization and ownership contracts |
| 3 | Simplify source analysis and create canonical Deployment Plan |
| 4 | Stabilize build, environment and dependency intelligence |
| 5 | Deliver agency/client/project ownership model |
| 6 | Implement the complete R1 Intelligence Harness |
| 7 | Deliver validated prompt-to-plan interaction |
| 8 | Integrate static hosting and complete approved profile certification |
| 9 | Deliver verified operational monitoring and cost visibility |
| 10 | Complete client handoff and the R1 customer journey |
| 11 | Execute controlled customer-pilot certification |
| 12 | Deliver R2 commercial management and operational intelligence |
| 13 | Deliver R3 governed self-healing |

Implementation stages are dependency boundaries, not instructions to rerun the entire test suite after every small change.

The engineering team shall preserve the existing verified functionality throughout implementation.

---

# 18. Explicit Product Exclusions

The following capabilities are excluded from the frozen R1–R3 scope.

- Multi-cloud hosting
- Kubernetes and EKS orchestration
- General-purpose AWS chatbot execution
- Microservice migration of DeployGuard
- Automatic provisioning of arbitrary databases
- Unrestricted support for every programming language
- Simultaneous deployment of arbitrary multi-service architectures
- General-purpose code generation or IDE replacement
- Training an independent foundation model
- Autonomous merging of AI-generated production code
- Unrestricted AI changes to customer IAM or Terraform
- Self-hosted developer portal frameworks
- Third-party automation suites duplicating the existing workflow engine
- Automated credit-card checkout and payment-provider integration
- Customer production deployment without approved AWS certification

These exclusions are product decisions, not unfinished requirements. Adding an excluded capability requires a new versioned scope change.

---

# 19. Business Model

### Customer type

B2B software agencies, AWS consultancies and managed application-delivery teams.

### Initial commercial offering

DeployGuard shall be offered through directly managed agency pilots with a documented service agreement and invoice-based commercial relationship.

### Pricing structure

The initial commercial pricing unit shall be the agency organization, with entitlement limits for team members, managed clients, projects and platform usage.

AWS infrastructure charges shall remain separate from DeployGuard platform fees and shall be paid through the customer's AWS billing relationship.

The system shall not calculate customer AWS usage as DeployGuard subscription revenue.

### Commercial validation

Before broader commercial launch, DeployGuard shall seek:

- At least 10 interviews with the defined target buyer segment.
- At least three qualified agencies willing to evaluate a representative workflow.
- At least two completed, independently reviewed client-style deployment and handoff pilots.
- A documented paid-pilot commitment or evidence explaining why agencies decline to purchase.

Pilot pricing shall be established through direct commercial agreements rather than invented product-market assumptions embedded in application code.

### Commercial success measures

- Time required to deliver an application.
- Number of manual engineering interventions.
- Deployment and rollback correctness.
- Completeness of client handoff evidence.
- Customer-reported operational visibility.
- Accuracy and limitations of cost estimates.
- Repeat use across agency client engagements.
- Verified willingness to pay.

---

# 20. Final Definition of Product Completion

### R1 is complete when:

1. An agency can create and manage an authorized client engagement.
2. A supported repository can be analyzed accurately.
3. The Intelligence Harness produces explainable deployment requirements and plans.
4. Natural-language requests can prepare validated plans.
5. An authorized user can approve infrastructure and cost.
6. DeployGuard can execute and verify supported AWS deployments.
7. The platform records source, infrastructure and release ownership.
8. Monitoring reports truthful application states.
9. Failed releases can be investigated and safely rolled back.
10. Resource cleanup preserves shared or unauthorized resources and verifies owned-resource absence.
11. Client handoff can be generated from verified records.
12. Tenant isolation and required security checks pass.
13. Authorized AWS lifecycle certification passes for the supported hosting profiles.
14. A complete agency-style pilot workflow has been demonstrated.

### R2 is complete when:

- Organizations and platform operators can manage commercial accounts and subscriptions.
- Usage and invoice records are accurate and auditable.
- Administrative privileges are correctly separated.
- Operational cost recommendations are evidence-based.
- Incident intelligence identifies observed facts separately from hypotheses.
- API assurance works against approved environments.
- R1 functionality remains operational.

### R3 is complete when:

- Remediation is limited to approved and verified runbooks.
- Infrastructure mutations remain policy-controlled.
- Recovery outcomes are independently verified.
- Failed recovery cannot be presented as successful.
- Code repair produces reviewable pull requests rather than uncontrolled production changes.
- The operational audit record remains complete.

---

# 21. Final Product Decision

DeployGuard shall be developed as an:

**Intelligent AWS Client Delivery and Operations Control Plane for Software Agencies.**

Its central product capability shall be the **Intelligence Harness**, which combines repository understanding, infrastructure evidence, validated deployment planning, cost and security analysis, AI-assisted interaction, and controlled AWS execution.

Its commercial value shall come from delivering a reliable and transparent workflow for application deployment, ongoing operations, and client handoff—not from being a generic deployment platform or an unrestricted AI cloud chatbot.

### Requirement governance

This document is the proposed **DeployGuard Product Requirements Baseline v1.0**.

Upon explicit founder approval:

1. The R1, R2 and R3 boundaries are frozen as written.
2. Codex implementation shall trace work to these requirement identifiers.
3. The previous master implementation specification shall be reconciled with this approved baseline, not treated as a competing requirements document.
4. Existing verified implementation work shall be preserved.
5. Any product scope changes shall be recorded through an explicit, versioned change request.
6. Technical feasibility and live-service permissions shall be verified during implementation; no feature is represented as implemented or certified solely because it appears in this specification.

**End of Product Requirements Specification — Version 1.0**
