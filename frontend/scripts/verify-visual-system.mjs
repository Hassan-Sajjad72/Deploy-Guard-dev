import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../src/styles/tokens.css");
const base = read("../src/styles/base.css");
const components = read("../src/styles/components.css");
const shell = read("../src/styles/shell.css");
const entry = read("../src/styles/app.css");
const pageStyles = readdirSync(new URL("../src/styles/pages/", import.meta.url)).map((name) => read(`../src/styles/pages/${name}`)).join("\n");
const allStyles = [tokens, base, components, shell, pageStyles].join("\n");
const primitives = read("../src/components/common/DesignSystem.jsx");
const landing = read("../src/pages/Landing.jsx");
const header = read("../src/components/layout/AppHeader.jsx");
const layout = read("../src/components/layout/AppLayout.jsx");
const adminLayout = read("../src/components/layout/AdminLayout.jsx");
const index = read("../index.html");
const main = read("../src/main.jsx");
const theme = read("../src/context/ThemeContext.jsx");
const canonical = read("../src/components/projects/ProjectOverviewLifecycle.jsx");
const about = read("../src/pages/About.jsx");
const publicFooter = read("../src/components/layout/PublicFooter.jsx");
const publicHeader = read("../src/components/layout/PublicHeader.jsx");
const architecture = read("../src/components/marketing/DeployGuardArchitecture.jsx");
const routes = read("../src/routes/AppRoutes.jsx");

// One stylesheet system, one entry, in a fixed cascade order.
assert.match(main, /import "\.\/styles\/app\.css";/, "the app loads exactly one stylesheet entry");
assert.doesNotMatch(main, /legacy\.css|system\.css|cohesion\.css|product\.css|design-system\.css/, "retired stylesheet layers stay retired");
for (const retired of ["../src/styles.css", "../src/design-system.css", "../src/styles/legacy.css", "../src/styles/cohesion.css", "../src/styles/product.css", "../src/styles/system.css"]) assert.equal(existsSync(new URL(retired, import.meta.url)), false, `${retired} must not return`);
assert.ok(entry.indexOf("tokens.css") < entry.indexOf("base.css") && entry.indexOf("base.css") < entry.indexOf("components.css") && entry.indexOf("components.css") < entry.indexOf("shell.css") && entry.indexOf("shell.css") < entry.indexOf("pages/"), "cascade order: tokens → elements → components → shell → pages");

// Tokens: both themes define the same semantic roles.
const roles = ["--bg", "--surface", "--surface-2", "--line", "--line-strong", "--text", "--text-2", "--text-3", "--primary", "--on-primary", "--accent", "--ok", "--warn", "--bad", "--info"];
const darkBlock = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'), tokens.indexOf(':root[data-theme="light"]'));
const lightBlock = tokens.slice(tokens.indexOf(':root[data-theme="light"]'));
for (const role of roles) {
  assert.match(darkBlock, new RegExp(`${role}:`), `dark theme defines ${role}`);
  assert.match(lightBlock, new RegExp(`${role}:`), `light theme defines ${role}`);
}
for (const token of ["--font-sans", "--font-mono", "--content-max", "--radius", "--control-h", "--s-4", "--ease-out"]) assert.match(tokens, new RegExp(`${token}:`));
assert.doesNotMatch(allStyles, /backdrop-filter:\s*blur\((?:[3-9]\d|\d{3})px/, "no decorative heavy glass");
assert.doesNotMatch(allStyles, /background-clip:\s*text/, "no gradient text");

// Theme: system preference by default, user choice remembered, applied before paint.
assert.match(theme, /"system", "light", "dark"/);
assert.match(theme, /prefers-color-scheme: light/);
assert.match(index, /localStorage\.getItem\("deployguard-theme"\)/, "the theme is applied before first paint");
assert.match(index, /meta name="color-scheme" content="dark light"/);
assert.match(header, /export function ThemeSwitch/);
assert.match(adminLayout, /<ThemeSwitch \/>/, "the admin console offers the same theme control");

// Accessibility mechanics.
assert.match(base, /prefers-reduced-motion: reduce/);
assert.match(base, /:focus-visible/);
assert.match(base, /::selection/);
assert.match(base, /\.skip-link/);
assert.match(layout, /href="#main-content"/);
assert.match(layout, /id="main-content"/);
assert.match(layout, /mainRef\.current\?\.focus/, "route changes move focus to the new page");
assert.match(adminLayout, /href="#admin-main-content"/);
assert.match(adminLayout, /id="admin-main-content"/);
assert.match(primitives, /\["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"\]\.includes\(event\.key\)/);
assert.match(primitives, /role="tab" tabIndex=\{activeId === item\.id \? 0 : -1\}/);
assert.match(primitives, /aria-modal="true"/);
assert.match(primitives, /export function useDialogFocus/);
assert.match(primitives, /export function ConfirmPhraseDialog/, "destructive actions share one typed confirmation");
assert.match(primitives, /Colour is never the only signal/);

// Shared primitives.
for (const component of ["Button", "ActionMenu", "Status", "Badge", "StatusChip", "PageHeader", "Section", "Card", "Callout", "Skeleton", "EmptyState", "DataTable", "CopyValue", "Disclosure", "Tabs", "Modal", "ConfirmPhraseDialog", "DetailsDrawer"]) assert.match(primitives, new RegExp(`export function ${component}`), `${component} is a shared primitive`);
for (const retired of ["MetricCard", "ChartCard", "IssueCard", "ReadinessSummary", "StageRail", "glass-surface"]) assert.doesNotMatch(primitives, new RegExp(retired), `${retired} is retired`);

// Navigation: one header, tabs as links, horizontal scroll on narrow screens.
assert.match(layout, /<AppHeader projectId=\{selectedProjectId\} \/>/, "one header owns all authenticated navigation");
assert.doesNotMatch(layout, /Sidebar|Navbar/);
assert.match(header, /aria-expanded=\{open\}/);
assert.match(header, /event\.key === "Escape"/);
assert.match(header, /<NavLink/);
assert.match(shell, /\.header-tabs[\s\S]*overflow-x: auto/);
for (const label of ["Overview", "Deployments", "Infrastructure", "Monitoring", "Troubleshoot", "Settings"]) assert.match(header, new RegExp(`label: "${label}"`));
for (const retired of ["Environment", "Logs", "Cost & FinOps", "Detection", "Pre-flight"]) assert.doesNotMatch(header, new RegExp(`label: "${retired}"`));
assert.doesNotMatch(header, /CommandPalette|command-trigger/);
assert.match(routes, /lazy\(\(\) => import\(/, "route screens are split into lazy-loaded chunks");
assert.match(routes, /<Suspense fallback=\{<LoadingState message="Loading page…" \/>\}>/);
assert.match(canonical, /<PhaseRail phases=\{phases\}/);

// Public pages and binding brand commitments.
assert.match(landing, /The future doesn’t wait for infrastructure\. Neither do we\./);
assert.match(landing, /Example project, for illustration\./, "illustrative product data is labelled as such");
assert.match(landing, /<DeployGuardArchitecture \/>/);
assert.match(architecture, /<title id="dg-arch-title">DeployGuard cloud architecture<\/title>/);
assert.match(architecture, /className="dg-arch-compact"/, "the architecture has a readable narrow-screen summary");
assert.match(routes, /<Route element={<About \/>} path="\/about" \/>/);
for (const name of ["Hassan Sajjad", "Faria Fatima", "Tania Khawar"]) assert.match(about, new RegExp(name));
for (const title of ["Co-Founder & CEO", "DevOps Engineer", "Backend & Systems Engineer", "Backend & AI Engineer"]) assert.match(about, new RegExp(title));
for (const profile of ["https://github.com/Hassan-Sajjad72", "https://hassan-sajjad72.github.io/", "https://www.linkedin.com/in/hassan-sajjad-2751202b9", "https://github.com/232378taniakhawar", "https://www.linkedin.com/in/tania-khawar-8a0965372"]) assert.match(about, new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.equal((about.match(/designation: "Co-Founder/g) || []).length, 3);
assert.match(about, /links\.length/, "profiles that do not exist are not rendered as disabled placeholders");
for (const avatar of ["hassan", "faria", "tania"]) assert.match(about, new RegExp(`avatar: "${avatar}"`));
for (const credit of ["Asim Ali Fayyaz", "Yaseen Mushtaq", "Intelligement", "https:\/\/www.intelligement.com"]) assert.match(about, new RegExp(credit));
assert.match(about, /Ideas come in, assumptions get challenged, and stronger products make it out\./);
assert.match(about, /<PublicFooter \/>/);
assert.match(publicFooter, /aria-label="Footer navigation"/);
assert.match(publicFooter, /DeployGuard © 2026/);
assert.match(publicFooter, /aria-label="DeployGuard home"/);
assert.doesNotMatch(publicFooter, /to="\/projects"/);
assert.match(publicHeader, /to="\/admin\/login"/);

console.log("Visual system verification passed: one token-driven stylesheet system with light and dark themes, shared primitives, accessible navigation and dialogs, and the binding public content.");
