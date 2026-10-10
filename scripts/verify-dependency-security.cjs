const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const backend = createRequire(resolve(__dirname, "../backend/package.json"));
const frontend = createRequire(resolve(__dirname, "../frontend/package.json"));
// Resolve through the actual consumer, not an unrelated top-level copy.
const express = createRequire(backend.resolve("express"));
const proxyaddr = express("proxy-addr");
for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
  for (const address of ["203.0.113.9", "::ffff:203.0.113.9"]) {
    assert.equal(proxyaddr.compile(subnet)(address), false,
      "a short IPv6 trust prefix must not authorize arbitrary IPv4 clients");
    assert.equal(proxyaddr({ headers: { "x-forwarded-for": "192.0.2.1" }, socket: { remoteAddress: address } }, subnet), address,
      "an untrusted peer cannot replace the audit/client IP with its forwarded header");
  }
}
for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
  const trust = proxyaddr.compile(subnet);
  assert.equal(trust("10.0.0.1"), true, "correctly configured proxy trust remains compatible");
  assert.equal(trust("203.0.113.9"), false);
}
// Keep the hostile map outside the gate's own process. An unpatched library
// must fail this timed check rather than hanging every subsequent test.
const sourceMapPath = frontend.resolve("source-map-js");
const malformedMap = spawnSync(process.execPath, ["-e", `
  const assert = require("node:assert/strict");
  const { SourceMapConsumer, SourceNode } = require(process.argv[1]);
  const indexedMap = (line) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map: { version: 3, sources: ["fixture.js"], names: [], mappings: "AAAA", sourcesContent: ["const safe = 1;\\n"] } }] });
  assert.throws(() => new SourceMapConsumer(indexedMap(2147483647)), /Section offset line must not exceed/);
  const map = new SourceMapConsumer(indexedMap(9000000));
  assert.equal(SourceNode.fromStringWithSourceMap("const safe = 1;\\n", map).toString(), "const safe = 1;\\n");
`, sourceMapPath], { timeout: 3000, encoding: "utf8", maxBuffer: 4096 });
assert.equal(malformedMap.error, undefined, "hostile indexed source-map offsets must not block the event loop");
assert.equal(malformedMap.status, 0, "the source-map consumer must preserve valid code without unbounded work");
console.log("DEPENDENCY_SECURITY_REGRESSIONS=PASS PROXY_TRUST=1 FORWARDED_IP=1 INDEXED_SOURCE_MAP_BOUNDED=1");
