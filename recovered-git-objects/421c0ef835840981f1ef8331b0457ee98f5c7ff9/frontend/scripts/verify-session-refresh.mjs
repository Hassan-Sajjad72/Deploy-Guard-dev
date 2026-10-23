import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const authContext = readFileSync(new URL("../src/context/AuthContext.jsx", import.meta.url), "utf8");
const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const github = readFileSync(new URL("../src/pages/GithubConnecting.jsx", import.meta.url), "utf8");

assert.match(authContext, /refreshUser\(\)\.finally\(\(\) => setIsLoading\(false\)\)/, "only the initial session check may gate the page");
assert.doesNotMatch(authContext, /const refreshUser[\s\S]*?setIsLoading\(true\)/, "focus and visibility checks must not remount the active route");
assert.match(projects, /window\.setTimeout\(\(\) => navigate\(location\.pathname, \{ replace: true, state: null \}\), 4200\)/, "archive success feedback must dismiss without a reload");
assert.match(github, /github_oauth_state_invalid/, "OAuth state collision is explained safely to the user");
assert.match(github, /github_oauth_callback_failed/, "callback failures retain a safe diagnostic category");

console.log("Session refresh, transient success feedback, and GitHub OAuth failure presentation verification passed.");
