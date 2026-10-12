// Runs the generated VM runtime (start.py) locally against stub docker/aws binaries, so bootstrap
// defects surface here instead of as a refused port 443 after a ten-minute live readiness window.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const importModule = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const uuid = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

async function main() {
  const { vmBootstrap } = await importModule(resolve(__dirname, "../../infrastructure/hosting-profiles/compute.mjs"));
  const scope = { projectId: uuid(1), generationId: uuid(2), sourceSha: "a".repeat(40), planFingerprint: "b".repeat(64), region: "us-east-1" };
  const service = { id: uuid(3), name: "dg-app-0", port: 8080, cpu: 0.5, memoryMiB: 256, publicEnvironment: { MODE: "test" }, secretReferences: [], image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/dg-x@sha256:" + "c".repeat(64), runAs: "1000:1000" };
  const config = (profile: string) => ({ scope, profile, services: [service], entrypointServiceId: service.id, proxy: { image: "caddy@sha256:" + "d".repeat(64) }, dns: { domain: "g-test.test.deployguard.me" }, ...(profile === "ec2" ? { logGroup: "/deployguard/test" } : {}) });

  for (const profile of ["ec2", "lightsail"]) {
    const script: string = vmBootstrap(config(profile));
    assert(!script.includes("awscli2 "), "Amazon Linux 2023 names the AWS CLI package awscli-2");
    assert(!script.includes("awslogs-create-stream"), "Docker's awslogs driver has no awslogs-create-stream option");
    assert(script.includes("StandardError=journal+console"), "runtime failures must reach the serial console");
    // Lightsail prepends its own /bin/sh launch steps, so the body must be POSIX: Ubuntu 22.04's dash rejects pipefail.
    const shellPart = script.replace(/<<'(DG_[A-Z]+)'\n[\s\S]*?\n\1\n/g, "");
    assert(script.startsWith("#!/bin/sh\n") && !/pipefail|\[\[|\bfunction\b|<<<|\$\(\(/.test(shellPart), `${profile}: bootstrap shell must be POSIX sh`);
    const dir = await mkdtemp(join(tmpdir(), "dg-vm-bootstrap-"));
    try {
      const local = script.replaceAll("/opt/deployguard", dir).replaceAll("/run/deployguard", join(dir, "run")).replaceAll("/etc/systemd/system", dir);
      // Stubs record every invocation; `docker network inspect` fails so the network is created.
      for (const bin of ["docker", "aws", "apt-get", "dnf", "systemctl"]) {
        await writeFile(join(dir, bin), `#!/bin/sh\necho "${bin} $*" >> "${join(dir, "calls.log")}"\n[ "$1 $2" = "network inspect" ] && exit 1\necho stub\n`);
        await chmod(join(dir, bin), 0o755);
      }
      // The whole user data runs under /bin/sh behind a Lightsail-style prefix, exactly as a combined launch script.
      await writeFile(join(dir, "launch.sh"), `#!/bin/sh\necho lightsail-prefix\n${local}`);
      await run("/bin/sh", [join(dir, "launch.sh")], { env: { PATH: `${dir}:/usr/bin:/bin` } });
      const boot = await readFile(join(dir, "calls.log"), "utf8");
      assert(boot.includes(profile === "ec2" ? "dnf install -y docker python3 awscli-2" : "apt-get -o DPkg::Lock::Timeout=600 install -y docker.io python3"), `${profile}: packages install`);
      assert(boot.includes("systemctl enable --now deployguard-runtime.service"), `${profile}: the runtime unit is enabled`);
      await run("python3", ["-I", join(dir, "start.py")], { env: { PATH: `${dir}:/usr/bin:/bin` } });
      const calls = await readFile(join(dir, "calls.log"), "utf8");
      assert(calls.includes(`docker run -d --name dg-app-0`), `${profile}: the application container starts`);
      assert(/docker run -d --name dg-tls .* -p 443:443 /.test(calls), `${profile}: the TLS proxy publishes port 443`);
      assert.equal(calls.includes("--log-driver awslogs"), profile === "ec2", `${profile}: only EC2 ships container logs to CloudWatch`);
      const caddyfile = await readFile(join(dir, "Caddyfile"), "utf8");
      assert(caddyfile.includes("reverse_proxy dg-app-0:8080") && caddyfile.includes(scope.planFingerprint), `${profile}: Caddy proxies the entrypoint and serves the identity proof`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  console.log("VM bootstrap checks passed: POSIX user data under a /bin/sh prefix, package names, Docker log options, console diagnostics, and the EC2 and Lightsail runtimes reaching the TLS proxy.");
}
void main().catch((error) => { console.error(error); process.exit(1); });
