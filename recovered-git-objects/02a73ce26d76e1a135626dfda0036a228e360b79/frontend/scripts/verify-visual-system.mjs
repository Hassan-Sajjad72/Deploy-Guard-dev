import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const primitives = readFileSync(new URL("../src/components/common/DesignSystem.jsx", import.meta.url), "utf8");
const landing = readFileSync(new URL("../src/pages/Landing.jsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/layout/Sidebar.jsx", import.meta.url), "utf8");
const navbar = readFileSync(new URL("../src/components/layout/Navbar.jsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../src/components/projects/CanonicalDeploymentView.jsx", import.meta.url), "utf8");

for (const token of ["#F7F8F4", "#FFFFFF", "#F1F5EE", "#B8F34A", "#8B5CF6", "#22C7D6", "#F45B7A", "#F5A524", "#22A65A", "#E5E9E0"]) assert.match(styles, new RegExp(token));
assert.match(styles, /--accent-hover:#A4DE36/);
assert.match(styles, /prefers-reduced-motion/);
assert.match(main, /dataset\.theme = "light"/);
for (const component of ["Button", "Card", "StatusChip", "Modal", "Banner", "Skeleton", "StageRail"]) assert.match(primitives, new RegExp(`export function ${component}`));
assert.match(canonical, /<StageRail phases=\{phases\}/);
assert.match(landing, /You build the idea\. DeployGuard handles the cloud\./);
assert.match(landing, /role === "admin"/);
assert.doesNotMatch(navbar, /toggleTheme|Switch to/);
for (const label of ["Overview", "Pipeline", "Infrastructure", "Monitoring"]) assert.match(sidebar, new RegExp(`label: "${label}"`));
for (const retired of ["Environment", "Logs", "Settings", "Cost & FinOps", "Detection", "Pre-flight"]) assert.doesNotMatch(sidebar, new RegExp(`label: "${retired}"`));

console.log("Visual system verification passed: light tokens, shared primitives, focused shell, stage rail and reduced motion.");
