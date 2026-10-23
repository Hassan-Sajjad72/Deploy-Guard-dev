**DeployGuard Test4 — Frontend UI Change Specification**  
**Scope and source-of-truth note**  
This specification is based on:  
- the current Test4 screenshots supplied in chat,  
- the verified DeployGuard frontend route/page structure from the repository (Landing, About, Dashboard, Projects, NewProject, ProjectDetails, ProjectPipeline, ProjectInfrastructure, ProjectMetrics, ProjectSettings, ProjectTroubleshooting, Billing, AdminLogin, AdminUsers, GithubConnecting, Forbidden),  
- the actual content/functional responsibilities already present in those pages/components,  
- established UI patterns from Vercel project dashboards, GitHub Actions workflow runs, AWS VPC resource maps, Grafana observability dashboards, Stripe billing portals, and Sentry issue-detail/troubleshooting pages.  
Important: the remote GitHub repository currently does not expose a test4 branch, so this document cannot claim a line-by-line inspection of the local Test4 source. The screenshots show the Test4 output, while the verified repository structure supplies the product information architecture. Before implementation, push Test4 or provide the local frontend folder so the exact Test4 files can be audited.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAM0lEQVR4nO3OMQ0AIAwAwdIgBKl1gjacsGCAiZDcTT9+q6oRETMAAPjF6ify6QYAADdyA9Y0AypN+bdfAAAAAElFTkSuQmCC)  
**1. Core design rule**  
DeployGuard must have **one coherent product identity but multiple page-specific UI templates**.  
Shared globally:  
- typography family and scale,  
- spacing scale,  
- border-radius system,  
- icon family,  
- button mechanics,  
- input mechanics,  
- navigation mechanics,  
- semantic status colors,  
- accessibility/contrast standard.  
Do **not** share globally:  
- one page background color,  
- one accent color,  
- one card treatment,  
- one density level,  
- one dashboard layout,  
- one visual hierarchy.  
The current Test4 problem is exactly this: a light surface + pale mint/green/teal treatment has been spread across unrelated pages. This creates weak contrast, visual sameness, and incorrect semantic use of green.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSPBCj7fFwtCmJHAjAU2QtIq6DIzW7UHAMBfnGt1V8fHEQAA3rsexOkF3va0dq8AAAAASUVORK5CYII=)  
**2. Global color foundation**  
Use these only as shared neutral tokens:  
- Primary text: #0F172A  
- Secondary text: #475569  
- Muted text: #64748B  
- Light border: #E2E8F0  
- Neutral page background: #F8FAFC  
- White surface: #FFFFFF  
- Dark technical surface: #111827  
Semantic colors:  
- Success / LIVE / healthy / verified: #16A34A  
- Failure / destructive: #DC2626  
- Warning / attention: #D97706  
- Informational: #2563EB  
Brand gold/amber is for primary CTAs or premium emphasis only, not success state.  
Never use pale mint/cyan as the normal navigation or body-text color.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd40A5GMORPYEt7WMGbCFuCLTNzVFcAAPzFvVZbdX49AQDgtf0BSrIDUgOg4eAAAAAASUVORK5CYII=)  
**3. Page-specific redesign matrix**  
**Landing / Public homepage**  
**Purpose**  
Explain DeployGuard quickly and visually: repository -> verified cloud runtime.  
**Palette**  
- Background: near-black/navy #061018 / #081822  
- Main text: #F8FAFC  
- Secondary text: #CBD5E1  
- Brand accent: amber #F5B73D  
- Architecture/network accents: blue/cyan #38BDF8 / #2563EB  
- Green: only tiny verified/healthy indicators, never large decorative green panels.  
**Required layout**  
- Premium dark hero.  
- Large headline on left/front layer.  
- Actual architecture illustration integrated into the **hero background**, not placed in a generic rectangular card.  
- Architecture can extend behind and to the right of the headline with controlled opacity/depth.  
- Top nav (About us, admin/sign-in) must be redesigned as part of the same composition.  
**Required architecture content**  
Conceptual platform flow:  
   
 GitHub repository -> DeployGuard -> GitHub Actions -> ECR -> ALB/ECS/Fargate -> Route53/public endpoint.  
Supporting layer:  
   
 VPC boundary, CloudWatch/observability, Terraform/state, optional database, cost visibility.  
The architecture is conceptual marketing content; do not pretend it is the current project's exact live AWS topology.  
**Remove from current Test4**  
- Large green blocks.  
- A normal dashboard-card container around the architecture.  
- Excessively uniform dark-teal surfaces.  
- Unchanged-looking About/Admin controls.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJmkPYLLpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfHEQAA3rseaHkEMn1wK7sAAAAASUVORK5CYII=)  
**About Us**  
**Purpose**  
Mission, founders, mentor/acknowledgements, product story.  
**Palette**  
- Editorial dark navy or warm off-white, independent of operational dashboards.  
- Suggested dark version: #0B1020, ivory #F8F5EE, amber detail #D6A84B.  
- Do not use operational green except if a real status is shown (normally none).  
**Required elements**  
- Strong editorial headline.  
- Mission statement.  
- Founder profiles in asymmetric editorial layout, not generic KPI cards.  
- Mentor / acknowledgement section.  
- Product story / build philosophy.  
- Optional subtle architectural linework as background texture.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AUBBAsUeCE4yeIiT9CRVMWGAjJK2CbjNzVGcAAPzF2qu7Wl9PAAB47XoA/vcF8exqpY4AAAAASUVORK5CYII=)  
**Home / Workspace Dashboard**  
**Purpose**  
Answer: What needs my attention right now?  
**Palette**  
- Light neutral workspace.  
- White surfaces.  
- Blue primary information accent #2563EB.  
- Red for failed/needs attention.  
- Green only for LIVE/success.  
- Amber for deploying/warning.  
**Existing data to preserve**  
- Total projects.  
- LIVE.  
- Deploying.  
- Needs attention.  
- Projects requiring action.  
- Active deployments.  
- Recently used projects.  
- Create Project.  
**UI pattern**  
Use a Vercel-style developer dashboard hierarchy:  
- compact KPI strip,  
- project/action list,  
- recent deployments,  
- recent projects.  
Avoid giant cards and decorative gradients.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSPBCj7fFwtCmJHAjAU2QtIq6DIzW7UHAMBfnGt1V8fHEQAA3rsexOkF3va0dq8AAAAASUVORK5CYII=)  
**Projects**  
**Purpose**  
Find/open/manage projects quickly.  
**Palette**  
- White/off-white base.  
- Indigo/blue accent #4F46E5 or #2563EB for selection/navigation.  
- Semantic project states retain green/red/amber.  
**Existing data to preserve**  
- Search.  
- Project name.  
- Services.  
- Latest deployment.  
- Last activity.  
- Open project.  
- Deploy new project.  
**UI pattern**  
- Search/filter toolbar.  
- Dense list or project cards with clear status and repo/branch information.  
- Optional small production preview thumbnail where available.  
- Do not make it another Home page KPI grid.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd4NIGRTPXNaQBrWMGbCFuCLTOzV2cAAPzFvVZbdXw9AQDgtesBhZQEOYZGgUEAAAAASUVORK5CYII=)  
**New Project / Deploy Wizard**  
**Purpose**  
Configure source, services, runtime, database, then deploy.  
**Palette**  
- Neutral white workspace.  
- Cobalt/indigo #4F46E5 for the wizard/action path.  
- GitHub black/neutral for repository identity.  
- AWS orange only where cloud/runtime steps are introduced.  
**Existing data to preserve**  
- GitHub App connection.  
- Authorized repository.  
- Branch.  
- Applications/services.  
- Service directory/name.  
- detected port.  
- environment variables.  
- Open Application service.  
- managed/external database.  
- database attachment.  
- deploy action.  
**UI pattern**  
A real step-based deployment wizard:  
1. Repository  
2. Services  
3. Runtime/configuration  
4. Database  
5. Review & Deploy  
Do not present all configuration as one endless page of equal cards.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OsQ1AABRAwSdRaPXGMOCv7WkPK+hEcjfBLTNzVFcAAPzFvVZbdX49AQDgtf0BSpoDXv5TGXgAAAAASUVORK5CYII=)  
**Project Overview**  
**Purpose**  
Control center for the current release.  
**Palette**  
- White/off-white base.  
- Strong slate/navy typography.  
- Green only for LIVE/healthy/completed.  
- Amber only for primary actions/warnings.  
- Red only for destructive/failure.  
**Existing data to preserve**  
- Project name.  
- environment/repository/branch/release.  
- current lifecycle.  
- Open Application.  
- Redeploy.  
- Rollback.  
- Destroy.  
- deployment status.  
- live URL.  
- service health.  
- monthly cost.  
- current release / release ID / service count / latest operation / duration.  
**Required information architecture**  
Top: compact project header + release metadata + actions.  
   
 Second: four summary metrics (deployment status, live URL, service health, monthly cost).  
   
 Third: lifecycle stepper.  
   
 Fourth: runtime/service summary and recent release info.  
**Critical correction**  
**Remove ** **NotificationSettingsPanel** ** from Project Overview.** Notification configuration belongs in Project Settings. It is currently making the Overview feel like a settings form and destroys the information hierarchy.  
Lifecycle:  
- complete = green node + green connector,  
- current/running = blue/amber depending state,  
- pending = neutral gray,  
- failed = red.  
No huge green line plus another duplicated green step line unless both communicate distinct information.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhZscZXlheJwqQgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseop8EQrmJduIAAAAASUVORK5CYII=)  
**Pipeline**  
**Purpose**  
Explain exactly what happened during execution.  
**Palette**  
- Light outer workspace.  
- Dark graphite execution console/panel #111827 or #0B1220.  
- White/gray text inside dark region.  
- Blue/cyan for current technical step.  
- Green passed, red failed, amber warning.  
**Existing data to preserve**  
- latest deployment / attempt.  
- operation.  
- duration.  
- completed time.  
- Trivy/container security.  
- technical stage timeline.  
- evidence.  
- GitHub Actions links.  
- advanced run details.  
- attempt history.  
- generation/type/result/commit/duration/time/retry.  
- recovery/diagnosis panel.  
**UI pattern**  
GitHub Actions-style execution page:  
- left stage/job rail,  
- right selected-stage evidence/log panel,  
- compact run summary above,  
- attempt history below.  
Do not create a generic dark card with low-contrast dark text.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJuUPYDMpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaHEEM+cJoFcAAAAASUVORK5CYII=)  
**Infrastructure**  
**Purpose**  
Show actual deployed cloud topology and resource state.  
**Palette**  
- White/cool-gray base.  
- AWS orange #FF9900 for AWS service identity and key infrastructure accents.  
- Network blue #2563EB.  
- Public subnet green and private subnet blue only inside the topology if representing AWS VPC semantics.  
- Health green only on resource status.  
**Existing data to preserve**  
- VPC.  
- ECS.  
- ALB.  
- database.  
- environment/region.  
- monthly cost.  
- source/build/ECR/runtime/routing state.  
- application endpoint.  
- running services.  
- Terraform.  
- CloudWatch.  
- Infracost.  
- resource details.  
- destroy state/evidence.  
**Required primary visual**  
The current “Source -> Build -> ECR -> VPC -> ECS -> ALB -> Route53” row is not enough.  
Render an actual **VPC-style topology map** based on the live data available:  
- Internet / DNS at the edge,  
- Route53,  
- ALB,  
- VPC boundary,  
- Availability Zones if known,  
- subnets if known,  
- ECS/Fargate services,  
- database/storage when configured,  
- CloudWatch/logging and ECR as supporting services.  
The topology must be the dominant element, with resource inventory and operations beneath it.  
If a resource is not present, do not invent it; render it as absent/not configured or omit it.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBACP6MMH6NpGACyywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AL+6BElk4wV6AAAAAElFTkSuQmCC)  
**Monitoring**  
**Purpose**  
Answer: Is the runtime healthy, and what is changing over time?  
**Palette**  
- Either light neutral dashboard with dark charts, or a controlled dark observability canvas.  
- Use distinct chart colors: blue, cyan, violet, amber, red.  
- Green only for healthy state indicators.  
- Do not make the entire monitoring page green.  
**Existing data to preserve**  
- service/runtime selection.  
- runtime details.  
- telemetry.  
- last scrape.  
- AWS observation/evidence freshness.  
- ALB health.  
- ECS task health.  
- Grafana link.  
- CloudWatch log stream.  
- logs filter/reconnect.  
**Required visual hierarchy**  
- metric strip: uptime/health, CPU, memory, requests, latency, error rate where available.  
- 2–4 time-series charts.  
- service health table.  
- alert/evidence panel.  
- dark log console.  
Follow Grafana-style panel density, not Overview-style cards.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNhRAF6EPYDLhGADSywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AIWsBDYDm5cLAAAAAElFTkSuQmCC)  
**Settings**  
**Purpose**  
Configuration, not monitoring.  
**Palette**  
- Very neutral white/gray.  
- Indigo/blue active tabs/actions.  
- Red only danger zone.  
- Minimal status color.  
**Existing data to preserve**  
- General: name, description, visibility/workspace.  
- Source: repository and deployment branch.  
- Services: deployable applications and entrypoint.  
- Variables: service environment variables.  
- Database: managed database and attached service.  
- Notifications.  
- Archive/delete/danger operations as currently supported.  
**UI pattern**  
GitHub/Vercel-style settings:  
- left or top settings navigation,  
- forms grouped by domain,  
- one clear Save action per section,  
- separate danger zone.  
**Critical correction**  
Move project email lifecycle notifications here exclusively. Do not duplicate them on Overview.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAM0lEQVR4nO3OUQmAQBBAwSdcjsu6HYxoDsEK/okwk2COmdnVGQAAf3GtalX76wkAAK/dDxFWBDkFf6+SAAAAAElFTkSuQmCC)  
**Troubleshoot**  
**Purpose**  
Diagnose a failed operation using deterministic evidence plus AI assistance.  
**Palette**  
- White/slate base.  
- Red for confirmed failure.  
- Amber for retry/attention.  
- Blue/violet for AI assistant/supporting analysis.  
- Dark evidence/log viewer.  
**Existing data to preserve**  
- failed attempt selector.  
- project/service.  
- deterministic owner.  
- pipeline failure code.  
- root cause.  
- retry decision.  
- recovery action.  
- commit/generation/stage/timestamp.  
- AI troubleshooting.  
- what happened / completed / root cause / recommended fix.  
- evidence references/viewer.  
- follow-up assistant.  
- analysis history.  
**UI pattern**  
Sentry issue-details style:  
- strong top diagnosis summary,  
- grouped facts,  
- progressive disclosure,  
- evidence/log drawer or panel,  
- AI assistant secondary to deterministic diagnosis.  
Do not make every evidence block permanently expanded.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQ2AQBAAsSE5CbzRujLwhwQMYIEfIWkVdJuZozoDAOAvrlWtav96AgDAa/cDEXQEKquakOYAAAAASUVORK5CYII=)  
**Billing / Plan & Usage**  
**Purpose**  
Understand plan, capacity, trial, upgrade options, payments and invoices.  
**Palette**  
- Warm white/ivory background.  
- Navy/charcoal text.  
- Gold/amber primary upgrade CTA.  
- Optional purple/indigo selected-plan accent.  
- Green only payment/active/trial success statuses.  
**Existing data to preserve**  
- billing disabled/test mode state.  
- observation mode.  
- current plan.  
- capacity / authoritative usage.  
- free LIVE trial.  
- billing period.  
- Stripe test-mode plans.  
- invoice history.  
- invoice detail/download.  
**UI pattern**  
Stripe-style billing portal + clear pricing comparison:  
- current plan hero,  
- usage meters,  
- pricing cards,  
- billing/subscription status,  
- invoice table.  
Do not use generic dashboard cards for every section.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OMQ0AIAwAwZIgBKn1gjJsdGLBABMhuZt+/JaZIyJmAADwi9VP1NMNAABu1AaU4gUeBSGW2wAAAABJRU5ErkJggg==)  
**Admin Login**  
**Purpose**  
Secure operator entry.  
**Palette**  
- Dark navy/charcoal.  
- White text/surface.  
- Blue/indigo focus state.  
- No green decoration.  
**Required elements**  
- dedicated operator access explanation,  
- email/password form,  
- clear separation from GitHub user auth,  
- security-oriented minimal layout.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBACPiUML0NpGACyywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AL/SBEZwuCSwAAAAAElFTkSuQmCC)  
**Admin Console**  
**Purpose**  
Operational platform administration.  
**Palette**  
- Cool-gray/white enterprise console.  
- Navy/blue navigation.  
- Green healthy.  
- Red failed/security/access blocked.  
- Amber warnings.  
- Purple can be reserved for admin/operator identity if desired.  
**Existing data to preserve**  
- platform/service readiness.  
- users & roles.  
- account access.  
- projects & operations.  
- owner/repository/state/latest operation/updated.  
- audit logs.  
- independent source failures/retry.  
**UI pattern**  
Dense admin console:  
- KPI/service-status strip,  
- tabbed Users / Projects / Audit,  
- real data tables,  
- filters/search,  
- restrained visual decoration.  
Do not style Admin like customer-facing Home or Landing.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJe0PYTKpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaIEEMYtKmi4AAAAASUVORK5CYII=)  
**GitHub Connecting**  
**Purpose**  
Short authentication transition.  
**Palette**  
- GitHub-neutral black/white with one DeployGuard accent.  
**UI**  
Single focused transition card, progress state, secure-auth explanation, cancel action. No dashboard chrome needed.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSPBCj5fFyM6mJHAjAU2QtIq6DIzW7UHAMBfnGt1V8fXEwAAXrsexOEF35f1aEgAAAAASUVORK5CYII=)  
**Forbidden / 403**  
**Purpose**  
Clear access-denied state.  
**Palette**  
Neutral background + restrained red accent.  
**UI**  
Large 403, concise explanation, one route-back action. No unnecessary cards.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAM0lEQVR4nO3OUQmAABBAsaeI2MKqV8RyJrGCfyJsCbbMzFldAQDwF/dWrdXx9QQAgNf2B/NkAzRb7P0YAAAAAElFTkSuQmCC)  
**4. Landing-page architecture requirement**  
DeployGuardArchitecture should not render as a standard dashboard card in the hero.  
Implement as a page-specific visual layer:  
- absolute or grid-positioned behind/right of hero copy,  
- SVG/React nodes and edges,  
- subtle grid/VPC boundary,  
- depth/blur/glow only behind architecture,  
- readable node labels,  
- controlled opacity where it intersects text,  
- responsive collapse into a simplified architecture on mobile.  
Suggested conceptual grouping:  
- Control path: GitHub -> DeployGuard -> GitHub Actions -> ECR  
- Runtime path: Route53/Internet -> ALB -> ECS/Fargate inside VPC  
- Supporting path: CloudWatch, Terraform/state, database, Infracost  
The diagram must be visually recognizable as cloud architecture before the user reads labels.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OQQmAABRAsScYxpg/i2XMYARvRrCCNxG2BFtmZquOAAD4i3Ot7mr/egIAwGvXA22YBcnkstSpAAAAAElFTkSuQmCC)  
**5. Card usage rule**  
Do not remove cards completely. Use cards only when the content is genuinely a discrete object.  
Good card use:  
- KPI metric,  
- pricing plan,  
- alert,  
- project item,  
- one service/resource,  
- one diagnosis summary.  
Bad card use:  
- wrapping every page section,  
- wrapping a large topology just because everything else is wrapped,  
- nested cards inside cards with no hierarchy,  
- giant empty cards containing one sentence.  
Use tables, timelines, topology diagrams, split panes, consoles, drawers, charts, tabs, and forms when those are the correct information patterns.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OQQmAABRAsad4FCtY9ecwnkms4E2ELcGWmTmrKwAA/uLeqrU6vp4AAPDa/gDzUgM9+S8z3AAAAABJRU5ErkJggg==)  
**6. Test4 changes that must be removed/fixed**  
1. Remove pale cyan/mint body/navigation text.  
2. Remove global green/teal decorative dominance.  
3. Remove oversized green-gray shadows around white cards.  
4. Fix any dark panel containing dark text.  
5. Stop reusing one page palette across Overview/Pipeline/Infrastructure/Monitoring/Billing.  
6. Replace Infrastructure's linear status row as the main diagram with actual VPC/resource topology.  
7. Integrate the conceptual architecture into the Landing hero background.  
8. Move NotificationSettingsPanel out of Project Overview into Settings only.  
9. Keep lifecycle green only as semantic completion status.  
10. Make each major route visually identifiable from a screenshot even if navigation is hidden.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBACPq8MH2NpGACyywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AL/KBEe6dElaAAAAAElFTkSuQmCC)  
**7. Codex execution method**  
Codex must work one page at a time in this order:  
   
 Landing -> About -> Home -> Projects -> New Project -> Overview -> Pipeline -> Infrastructure -> Monitoring -> Settings -> Troubleshoot -> Billing -> Admin Login -> Admin Console -> GitHub Connecting -> 403.  
For each page:  
1. Inspect the actual page/component source and its current API-backed data.  
2. Inspect the supplied screenshot references for that page.  
3. Search 3–4 high-quality current industry examples for that exact page type.  
4. Write down the page's information hierarchy before editing.  
5. Implement only that page and necessary shared primitives.  
6. Render and visually inspect desktop and mobile.  
7. Do not move to the next page until text contrast, hierarchy, overflow and page identity are acceptable.  
Do not make a single global CSS pass and call the redesign complete.  
For each route/page, before editing it, search Google Images and official product screenshots for 3–4 strong examples of that exact page type, study their information hierarchy, spacing, density, colors, and component patterns, then implement only the ideas that fit that specific DeployGuard page. Do this independently for Landing, Home, Projects, New Project, Overview, Pipeline, Infrastructure, Monitoring, Settings, Troubleshoot, Billing, About, Admin Login, Admin Console, GitHub Connecting, and 403. Do not reuse one page’s palette or layout across other pages just because it looked good elsewhere.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OQQmAABRAsad4FCtY9ecwnkms4E2ELcGWmTmrKwAA/uLeqrU6vp4AAPDa/gDzUgM9+S8z3AAAAABJRU5ErkJggg==)  
**8. Verification gate**  
   
For every page return one of:  
- PASS  
- NEEDS CORRECTION  
- UNVERIFIED  
PASS requires actual rendered-page inspection, not only unit tests/build success.  
Landing cannot PASS without a real architecture visual in the hero.  
   
 Infrastructure cannot PASS without an actual topology/resource diagram.  
   
 Monitoring cannot PASS without telemetry/charts/log hierarchy.  
   
 Pipeline cannot PASS if logs/evidence are low contrast.  
   
 Settings cannot PASS if notification configuration still appears in Overview.  
Backend behavior, API contracts, deployment lifecycle logic and cloud execution logic must remain untouched.  
