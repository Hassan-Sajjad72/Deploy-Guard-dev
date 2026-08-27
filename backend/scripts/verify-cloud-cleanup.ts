import { strict as assert } from "node:assert";
import { ProjectCloudInventoryService, ProjectCloudResource } from "../src/infrastructure-lifecycle/project-cloud-inventory.service";

async function main() {
  const calls: string[][] = [];
  const service = Object.create(ProjectCloudInventoryService.prototype) as ProjectCloudInventoryService;
  Object.assign(service as object, {
    aws: { run: async (args: string[]) => { calls.push(args); return { stdout: "{}", stderr: "" }; }, sanitize: (value: string) => value },
    config: { get: (_key: string, fallback: string) => fallback },
    terraformState: { inspectNativeLockfile: async () => ({ exists: true, stale: true, key: "projects/project-1/terraform.tfstate.tflock" }), clearStaleNativeLockfile: async () => ({ cleared: true }) },
  });
  const resource = (patch: Partial<ProjectCloudResource>): ProjectCloudResource => ({ id: "id", arn: "arn", name: "name", category: "other", source: "deployment_mapping", projectScoped: true, protected: false, cleanupSupported: true, risk: "low", costRisk: "low", deleteStatus: "found", reason: "test", ...patch });

  await (service as any).deleteResource("project-1", resource({ category: "ecr_repository", name: "mini-paas-project-project-1", arn: "arn:aws:ecr:us-east-1:1:repository/mini-paas-project-project-1" }));
  assert.deepEqual(calls[0], ["ecr", "delete-repository", "--repository-name", "mini-paas-project-project-1", "--force"]);
  await (service as any).deleteResource("project-1", resource({ category: "secret", name: "deployguard/project-1/dev/JWT_SECRET", arn: "arn:aws:secretsmanager:us-east-1:1:secret:deployguard/project-1/dev/JWT_SECRET" }));
  assert(calls[1].includes("--recovery-window-in-days"));
  await assert.rejects(() => (service as any).deleteResource("project-1", resource({ category: "secret", name: "deployguard/another-project/dev/JWT_SECRET" })), /outside the project prefix/);
  await assert.rejects(() => (service as any).deleteResource("project-1", resource({ category: "log_group", name: "/deployguard/another-project/dev/app" })), /outside the project prefix/);
  await assert.rejects(() => (service as any).deleteResource("project-1", resource({ category: "ecr_repository", protected: true })), /not eligible/);
  await assert.rejects(() => (service as any).deleteResource("project-1", resource({ category: "vpc" })), /Terraform destroy or manual review/);
  assert.equal((service as any).shouldReportResidue(3, null, []), false);
  assert.equal((service as any).shouldReportResidue(3, "unknown-operation", [{ id: "destroy-1" }]), false);
  assert.equal((service as any).shouldReportResidue(3, "destroy-1", [{ id: "destroy-1" }]), true);
  assert.equal((service as any).shouldReportResidue(0, "destroy-1", [{ id: "destroy-1" }]), false);
  console.log("Cloud cleanup scope verification passed: exact mappings allowed; shared, foreign-prefix, protected, and unsupported resources rejected.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
