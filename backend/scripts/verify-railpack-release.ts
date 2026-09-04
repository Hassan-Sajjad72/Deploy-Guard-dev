import { strict as assert } from "node:assert";
import { effectiveServicePort, RAILPACK_LINUX_X64_SHA256, RAILPACK_RELEASE_URL, RAILPACK_VERSION } from "../src/projects/railpack-release";

assert.match(RAILPACK_VERSION, /^\d+\.\d+\.\d+$/);
assert.match(RAILPACK_LINUX_X64_SHA256, /^[0-9a-f]{64}$/);
assert.match(RAILPACK_RELEASE_URL, new RegExp(`/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl\\.tar\\.gz$`));
assert.throws(() => effectiveServicePort(undefined), /Canonical service port/, "unresolved services never receive a generic fallback");
assert.equal(effectiveServicePort(3000), 3000);
assert.throws(() => effectiveServicePort(0), /Canonical service port/);
console.log(`RAILPACK_RELEASE=PASS version=${RAILPACK_VERSION} automaticServicePort=true`);
