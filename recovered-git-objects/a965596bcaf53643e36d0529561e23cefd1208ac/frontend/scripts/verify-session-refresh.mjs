import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const authContext = readFileSync(new URL("../src/context/AuthContext.jsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const github = readFileSync(new URL("../src/pages/GithubConnecting.jsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const environmentVariables = readFileSync(new URL("../src/components/projects/EnvironmentVariablesPanel.jsx", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../src/components/projects/NotificationSettingsPanel.jsx", import.meta.url), "utf8");

assert.match(authContext, /const refreshInFlight = useRef\(null\)/, "initial session refreshes share one in-flight request");
assert.match(authContext, /if \(refreshInFlight\.current\) return refreshInFlight\.current/, "Strict Mode cannot start a duplicate initial session request");
assert.match(authContext, /const generation = \+\+authStateGeneration\.current/, "each new refresh owns a generation");
assert.match(authContext, /generation !== authStateGeneration\.current/, "stale refresh completions cannot replace newer auth state");
assert.match(authContext, /authStateGeneration\.current \+= 1/, "logout invalidates an outstanding session refresh");
assert.match(authContext, /void refreshUser\(\)/, "only the initial session check may gate the page");
assert.doesNotMatch(authContext, /const refreshUser[\s\S]*?setIsLoading\(true\)/, "focus and visibility checks must not remount the active route");
assert.match(projects, /window\.setTimeout\(\(\) => navigate\(location\.pathname, \{ replace: true, state: null \}\), 4200\)/, "archive success feedback must dismiss without a reload");
for (const [name, source, state] of [["project settings", settings, "success"], ["environment variables", environmentVariables, "success"], ["notifications", notifications, "notice"]]) {
  assert.match(source, new RegExp(`window\\.setTimeout\\(\\(\\) => set${state[0].toUpperCase()}${state.slice(1)}\\(\\\"\\\"\\), 4200\\)`), `${name} success feedback must dismiss without a reload`);
}
assert.match(github, /github_oauth_state_invalid/, "OAuth state collision is explained safely to the user");
assert.match(github, /github_oauth_callback_failed/, "callback failures retain a safe diagnostic category");
assert.match(github, /github_oauth_account_disabled/, "disabled GitHub identities receive a safe actionable callback reason");
assert.doesNotMatch(github, /refreshUser\(\)\.then/, "the callback page must not issue a second session confirmation request");

console.log("Session refresh, transient success feedback, and GitHub OAuth failure presentation verification passed.");
