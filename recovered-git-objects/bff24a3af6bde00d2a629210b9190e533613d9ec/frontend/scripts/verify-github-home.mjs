import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const routes = readFileSync(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");
const landing = readFileSync(new URL("../src/pages/Landing.jsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const authApi = readFileSync(new URL("../src/api/authApi.js", import.meta.url), "utf8");
const authContext = readFileSync(new URL("../src/context/AuthContext.jsx", import.meta.url), "utf8");
const githubConnecting = readFileSync(new URL("../src/pages/GithubConnecting.jsx", import.meta.url), "utf8");

for (const route of ["/login", "/signup", "/dashboard"]) assert.match(routes, new RegExp(`<Route element=\\{<Navigate replace to="/" \\/>\\} path="${route.replaceAll("/", "\\/")}"`));
assert.match(routes, /path="\/deploy"/);
assert.match(routes, /<Route element=\{<Navigate replace to="\/deploy" \/>\} path="\/projects\/new"/);
assert.match(landing, /data-home-deploy="oauth"/);
assert.match(landing, /data-home-deploy="authenticated"/);
assert.equal((landing.match(/>Deploy(?:\s*<|<\/Link>)/g) || []).length, 2, "The two auth branches must define one Deploy CTA each, never render together.");
assert.match(landing, /<details className="landing-account-menu">/);
assert.match(landing, /<Link to="\/projects">Projects<\/Link>/);
assert.match(landing, /aria-label="Admin access"/);
assert.match(landing, /\{isAuthenticated \? \(/);
assert.match(landing, /state=\{\{ from: \{ pathname: "\/admin" \} \}\} to="\/auth\/github">Admin<\/Link>/);
assert.doesNotMatch(landing, /role === "admin"/);
assert.match(landing, /state=\{\{ from: \{ pathname: "\/deploy" \} \}\}/);
assert.doesNotMatch(landing, /summary>Account<\/summary>|Continue with GitHub/);
assert.doesNotMatch(landing, />\s*(?:Use email|Sign up|Log in)\s*</i);
assert.doesNotMatch(authApi, /signupUser|loginUser|\/api\/auth\/(?:signup|login)/);
assert.doesNotMatch(authContext, /\blogin\b|\bsignup\b/);
assert.doesNotMatch(githubConnecting, /to="\/login"/);
assert.match(githubConnecting, /: "\/deploy"/);
assert.match(projects, /latestAttempt\?\.operationId/);
assert.match(projects, /state === "all" \|\| projectStatePresentation/);
assert.match(projects, /value="destroyed"/);
assert.match(projects, /to="\/deploy"/);
assert.match(projects, /to=\{`\/projects\/\$\{project\.id\}`\}/);

console.log("GitHub-first Home verification passed.");
