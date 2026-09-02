import { strict as assert } from "node:assert";
import { DEPLOYGUARD_DEFAULT_SERVICE_PORT, effectiveServicePort, RAILPACK_LINUX_X64_SHA256, RAILPACK_RELEASE_URL, RAILPACK_VERSION } from "../src/projects/railpack-release";

assert.match(RAILPACK_VERSION, /^\d+\.\d+\.\d+$/);
assert.match(RAILPACK_LINUX_X64_SHA256, /^[0-9a-f]{64}$/);
assert.match(RAILPACK_RELEASE_URL, new RegExp(`/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl\\.tar\\.gz$`));
assert.equal(DEPLOYGUARD_DEFAULT_SERVICE_PORT, 8080);
assert.equal(effectiveServicePort(undefined), 8080, "legacy services default safely without mutating historical storage");
assert.equal(effectiveServicePort(3000), 3000);
assert.throws(() => effectiveServicePort(0), /Application port/);
console.log(`RAILPACK_RELEASE=PASS version=${RAILPACK_VERSION} defaultServicePort=${DEPLOYGUARD_DEFAULT_SERVICE_PORT}`);
