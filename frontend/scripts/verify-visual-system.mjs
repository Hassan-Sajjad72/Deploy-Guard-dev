import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const main = read("../src/main.jsx");
const index = read("../index.html");
const system = read("../src/styles/system.css");
const motion = read("../src/styles/motion.css");
const pageStyles = Object.fromEntries([
  "about", "admin", "audit", "billing", "cloud-cleanup", "gate", "home", "infrastructure",
  "landing", "monitoring", "new-project", "overview", "pipeline", "projects", "settings", "troubleshoot",
].map((name) => [name, read(`../src/styles/pages/${name}.css`)]));
const allActiveStyles = `${system}\n${motion}\n${Object.values(pageStyles).join("\n")}`;
const primitives = read("../src/components/common/DesignSystem.jsx");
const theme = read("../src/context/ThemeContext.jsx");
const landing = read("../src/pages/Landing.jsx");
const about = read("../src/pages/About.jsx");
const sidebar = read("../src/components/layout/Sidebar.jsx");
const navbar = read("../src/components/layout/Navbar.jsx");
const layout = read("../src/components/layout/AppLayout.jsx");
const adminLayout = read("../src/components/layout/AdminLayout.jsx");
const canonical = read("../src/components/projects/ProjectOverviewLifecycle.jsx");
const architecture = read("../src/components/marketing/DeployGuardArchitecture.jsx");
const publicFooter = read("../src/components/layout/PublicFooter.jsx");
const publicAdminLink = read("../src/components/layout/PublicAdminLink.jsx");
const githubConnecting = read("../src/pages/GithubConnecting.jsx");
const routes = read("../src/routes/AppRoutes.jsx");
const settings = read("../src/pages/ProjectSettings.jsx");

// One active import path: page styles layer on the foundation, then motion.
assert.match(main, /import "\.\/styles\/system\.css"/);
for (const page of Object.keys(pageStyles)) assert.ok(main.includes(`import "./styles/pages/${page}.css";`), `main.jsx imports ${page} styles`);
assert.match(main, /import "\.\/styles\/motion\.css"/);
assert.ok(main.indexOf("./styles/system.css") < main.indexOf("./styles/pages/about.css"));
assert.ok(main.indexOf("./styles/pages/troubleshoot.css") < main.indexOf("./styles/motion.css"));
assert.doesNotMatch(main, /styles\.css|design-system\.css|aurora\.css|cohesion\.css|Atmosphere/);
assert.match(theme, /function initialTheme\(\)\s*\{\s*return "light";/, "the product shell starts in the light theme");
assert.match(system, /html \{ background: var\(--dg-canvas\); color-scheme: light;/);
assert.match(system, /body\s*\{[^}]*background: var\(--dg-canvas\);[^}]*color: var\(--dg-ink\)/);

// Shared tokens and the light shell / deep-blue technical-surface split.
for (const token of ["--dg-page", "--dg-canvas", "--dg-surface", "--dg-ink", "--dg-ink-2", "--dg-muted", "--dg-primary", "--dg-success", "--dg-warning", "--dg-danger", "--dg-console", "--dg-radius-lg", "--dg-font", "--dg-mono"]) {
  assert.match(system, new RegExp(token));
}
assert.match(system, /\.dg-dark,\s*\[data-ground="night"\]\s*\{/);
assert.match(system, /--dg-canvas: var\(--technical-canvas\)/);
assert.match(system, /\.dg-dark \{ background-color: var\(--technical-canvas\); color: var\(--dg-ink\); \}/);
assert.match(system, /\.dg-console, \.monitoring-log-viewer, pre\.dg-console/);
assert.match(system, /body::before\s*\{[\s\S]*radial-gradient/);
assert.match(system, /body::after\s*\{[\s\S]*linear-gradient/);
assert.doesNotMatch(system, /body::before\s*\{[^}]*animation:/, "ambient light is static rather than a continuous animated backdrop");
assert.match(system, /\.app-shell\s*\{[^}]*grid-template-columns: var\(--sidebar-width\)/);
assert.match(system, /\.sidebar\s*\{[^}]*border-radius: var\(--dg-radius-lg\)/);
assert.match(system, /@media \(max-width: 820px\)[\s\S]*\.sidebar\.is-mobile-open/);
assert.match(system, /\.mobile-navigation-toggle, \.mobile-navigation-close/);
assert.match(system, /\.mobile-navigation-backdrop\.is-open/);
assert.match(system, /:focus-visible/);
assert.match(motion, /prefers-reduced-motion/);
assert.match(motion, /\.page-transition/);
for (const color of ["#f97316", "#ec4899", "#a855f7", "#8b5cf6", "#ff00ff"]) assert.doesNotMatch(allActiveStyles, new RegExp(color, "i"));
assert.match(pageStyles.infrastructure, /\.itw-body\s*\{[\s\S]*var\(--technical-canvas\)/);
assert.match(pageStyles.pipeline, /\.pg-columns\.dg-dark[\s\S]*var\(--technical-canvas\)/);
assert.match(pageStyles.monitoring, /\.monitoring-log-viewer\s*\{[\s\S]*background: var\(--technical-canvas\)/);
assert.match(pageStyles.landing, /\.dg-hero-visual\s*\{[^}]*background: var\(--technical-canvas\)/);

for (const component of ["Button", "Card", "MetricCard", "StatusChip", "PageHeader", "Modal", "Banner", "EmptyState", "Skeleton", "DataTable", "CopyValue", "ChartCard", "StageRail", "Tabs", "DetailsDrawer"]) {
  assert.match(primitives, new RegExp(`export function ${component}`));
}
for (const component of ["ActionBar", "DataRow", "IssueCard", "ReadinessSummary"]) assert.match(primitives, new RegExp(`export function ${component}`));
assert.match(primitives, /role="tab" tabIndex=\{activeId === item\.id \? 0 : -1\}/);
assert.match(primitives, /aria-orientation=\{orientation\}/);
assert.match(primitives, /orientation === "vertical" \? "ArrowDown" : "ArrowRight"/);
assert.match(primitives, /orientation === "vertical" \? "ArrowUp" : "ArrowLeft"/);
assert.match(settings, /orientation="vertical"/);
assert.match(pageStyles.settings, /\.dg-set-nav \.ds-tabs \{ max-height: 214px; overflow-y: auto;/, "narrow settings navigation retains a scrollable vertical tab list");
assert.match(canonical, /<StageRail phases=\{phases\}/);

// Responsive navigation, accessible shell landmarks, and unchanged route intent.
assert.doesNotMatch(navbar, /toggleTheme|Switch to/);
assert.match(navbar, /aria-controls="authenticated-navigation"/);
assert.match(layout, /navigationOpen/);
assert.match(layout, /href="#main-content"/);
assert.match(layout, /id="main-content"/);
assert.match(layout, /inert=\{navigationOpen \? "" : undefined\}/, "content behind mobile navigation is inert");
assert.match(adminLayout, /href="#admin-main-content"/);
assert.match(adminLayout, /id="admin-main-content"/);
assert.match(sidebar, /useDialogFocus\(onClose, \{ active: isOpen \}\)/);
assert.match(sidebar, /aria-modal=\{isOpen \? "true" : undefined\}/);
for (const label of ["Overview", "Pipeline", "Infrastructure", "Monitoring"]) assert.match(sidebar, new RegExp(`label: "${label}"`));
for (const retired of ["Environment", "Logs", "Cost & FinOps", "Detection", "Pre-flight"]) assert.doesNotMatch(sidebar, new RegExp(`label: "${retired}"`));
assert.match(routes, /lazy\(\(\) => import\(/, "route screens remain split into lazy-loaded chunks");
assert.match(routes, /<Suspense fallback=\{<LoadingState message="Loading page…"\s*\/>\}>/);
assert.match(routes, /<Route element=\{<About \/>} path="\/about" \/>/);
assert.match(index, /meta name="theme-color" content="#F6F8FB"/);

// The overview stays a summary; execution and telemetry have dedicated routes.
assert.doesNotMatch(canonical, /getGithubActionsDeploymentHistory|developerAction|estimatedCost|terraform/i);
assert.doesNotMatch(canonical, /<MetricCard|overview-summary-grid/);
assert.doesNotMatch(canonical, /applicationHealth|health\.observedAt|health\.source/);
assert.match(pageStyles.overview, /\.dg-overview/);
assert.match(pageStyles.overview, /\.dg-ov-services/);
assert.match(pageStyles.pipeline, /pipeline-stage-timeline/);
assert.match(pageStyles.monitoring, /monitoring-chart-grid/);
assert.match(pageStyles.infrastructure, /itw-canvas/);
assert.match(pageStyles.projects, /projects/);
assert.match(pageStyles.home, /dg-home/);
assert.match(pageStyles["new-project"], /\.dg-newproj/);
assert.match(pageStyles.troubleshoot, /\.dg-trouble/);
assert.match(pageStyles.billing, /dg-bill/);
assert.match(pageStyles["cloud-cleanup"], /\.central-cleanup-page/);
assert.match(pageStyles.gate, /dg-gate/);
assert.match(pageStyles.admin, /dg-admin/);
assert.match(pageStyles.audit, /dg-audit/);

// Public pages, copy, founders, and conceptual architecture remain intact.
assert.match(landing, /From repository to a verified cloud deployment\./);
assert.doesNotMatch(landing, /ECR|ECS Fargate|\bALB\b/);
for (const name of ["Hassan Sajjad", "Faria Fatima", "Tania Khawar"]) assert.match(about, new RegExp(name));
for (const title of ["Co-Founder & CEO", "DevOps Engineer", "Backend & Systems Engineer", "Backend & AI Engineer"]) assert.match(about, new RegExp(title));
for (const profile of ["https://github.com/Hassan-Sajjad72", "https://hassan-sajjad72.github.io/", "https://www.linkedin.com/in/hassan-sajjad-2751202b9", "https://github.com/232378taniakhawar", "https://www.linkedin.com/in/tania-khawar-8a0965372"]) {
  assert.match(about, new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.equal((about.match(/linkedin: null/g) || []).length, 1);
assert.equal((about.match(/github: null/g) || []).length, 1);
assert.equal((about.match(/portfolio: null/g) || []).length, 2);
assert.equal((about.match(/designation: "Co-Founder/g) || []).length, 3);
for (const line of ["Three founders.", "One platform.", "Different minds. Shared vision.", "Different specialties. Shared ownership.", "Our mission: Turn complex cloud deployment", "Meet the builders.", "Ideas come in, assumptions get challenged, and stronger products make it out."]) {
  assert.match(about, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(about, /href="#team"|href="#philosophy"|<Link to="\/">Home/);
for (const line of ["The force that carried an ambitious idea through every failure, rebuild, and breakthrough until it became real.", "The mind that finds clarity in the mess and a way forward when the obvious answers stop working.", "The thinker who questions what everyone else accepts—and often uncovers what nobody else thought to look for."]) {
  assert.match(about, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(about, /Built end to end|Three founders\. One product\. Built together\./);
for (const avatar of ["hassan", "faria", "tania"]) assert.match(about, new RegExp(`avatar: "${avatar}"`));
assert.match(about, /className="team-stack"/);
assert.match(pageStyles.about, /\.team-stack[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(pageStyles.about, /@media \(max-width: 620px\)[\s\S]*\.team-stack \{ grid-template-columns: 1fr/);
assert.match(about, /<PublicFooter \/>/);
assert.match(publicFooter, /aria-label="Footer navigation"/);
assert.match(publicFooter, /DeployGuard © 2026/);
for (const credit of ["Asim Ali Fayyaz", "Yaseen Mushtaq", "Intelligement", "https:\/\/www.intelligement.com"]) assert.match(about, new RegExp(credit));
assert.match(publicAdminLink, /className="landing-admin-link"/);
for (const stage of ["Source", "Build", "Publish", "Provision", "Verify", "Promotion gate"]) assert.match(architecture, new RegExp(stage));
assert.match(architecture, /Illustrative topology · not a live project view/);
assert.match(architecture, /Illustrative workflow · not a live project pipeline/);
assert.doesNotMatch(architecture, /us-east-1|10\.0\.0\.0\/16|targets healthy|CloudWatch|Terraform|Infracost|ECS Fargate|Application Load Balancer/);
assert.match(architecture, /Conceptual marketing illustration[\s\S]*not the live topology/);
assert.match(pageStyles.landing, /\.dg-arch-diagram/);
assert.match(pageStyles.landing, /\.dg-arch-links \.is-runtime/);
assert.match(pageStyles.landing, /\.dg-delivery-steps/);
assert.match(pageStyles.landing, /@media \(max-width: 760px\)[\s\S]*\.dg-delivery-steps/);
assert.match(githubConnecting, /GithubConnecting/);
assert.doesNotMatch(githubConnecting, /landing-ambient/);

console.log("Visual system verification passed: centralized light-first tokens, responsive shell, accessible primitives, dark technical canvases, focused Overview, and page composition.");
