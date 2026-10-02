---
version: 1
slug: "frontend-src"
primary_target: "frontend/src"
related_targets: []
---

# Surface brief: DeployGuard product app (Operate)

Scope: every authenticated surface (workspace, project, admin) plus the public landing, about and sign-in pages. Visitor mode: Operate (landing/about: Persuade, inheriting the same world).

Audience and job: developers who want a GitHub repo running on AWS without learning AWS; they return to check "is it live, what happened, what do I do". Admins are more technical.

Constraints: no backend changes; honesty rule (unverified is shown as unverified); one canonical owner per fact; destructive actions behind typed confirmation; light and dark themes.

Information architecture (decided):
- Projects (home): attention-first list; one row per project; reason inline only when attention is needed.
- Overview: owns current state. State sentence + URL + next action + current release identity + services. Minimal pointer to latest attempt.
- Deployments (route /pipeline): owns attempts, stages, history, raw run evidence. No diagnosis repetition; links to Troubleshoot.
- Troubleshoot: owns failure explanation, ownership, fix steps, recovery action, AI analysis, evidence.
- Infrastructure: owns topology, resource health, identifiers, cost estimate.
- Monitoring: owns metrics and live logs.
- Settings: owns configuration and the danger zone (archive, destroy infrastructure).
- Plan & usage, Admin (overview, users, projects, audit, cloud cleanup as header tabs).

## Direction contract
THESIS: The release ledger. Every screen opens with one plain-language state sentence, then anchors it to exact evidence one disclosure deeper. It refuses the card-grid dashboard and status-chip confetti that the category ships.
OWN-WORLD: Neutral graphite (dark) and paper (light) grounds; content sits on the page in hairline-ruled sections and grouped rows, cards only for real containment. One blue signal for focus, links and in-progress; green/amber/red only for verified state. Geist for reading, Geist Mono only for identifiers (commit, digest, run). Inverted-ink primary buttons, 8px radii.
STORY: The user sees whether the app is live and what changed, understands any failure in their own terms and whose problem it is, takes the one next action, and can always drill to the exact commit, image and run behind it.
FIRST VIEWPORT: Project Overview: breadcrumb header + tab row; a status line (dot, "Live", sentence with release and time) with the public URL at reading size and the primary action right-aligned; below it a two-column ledger: current release identity (commit → release → verified) and services; a one-line latest-attempt pointer.
FORM: Own pick (user forbade option rounds; no concept-seed roll ran). Position 1 of own list; seed key: none.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
