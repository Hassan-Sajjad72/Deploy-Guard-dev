import { strict as assert } from "node:assert";
import { CentralCloudResource } from "../src/infrastructure-lifecycle/central-cloud-resource.entity";
import { CloudCleanupSafetyService } from "../src/infrastructure-lifecycle/cloud-cleanup-safety.service";
import { CloudResourceClassifierService } from "../src/infrastructure-lifecycle/cloud-resource-classifier.service";
import { requireRole } from "../src/common/rbac/require-role.guard";
import { UserRole } from "../src/users/user.entity";

const projectId = "7672125f-f3b1-42e5-861c-455c0f722896";
const classifier = new CloudResourceClassifierService();
const safety = new CloudCleanupSafetyService();
const projects = new Map([[projectId, { id: projectId, name: "Test", infrastructureStatus: "destroyed" }]]);

const taggedLog = classifier.classify({ resourceKey: "log", name: `/deployguard/${projectId}/dev/app`, resourceType: "log_group", awsService: "logs", region: "us-east-1", source: "discovered_tag", tags: { ManagedBy: "DeployGuard", ProjectId: projectId } }, projects);
assert.equal(taggedLog.status, "cleanup_required");
assert.equal(taggedLog.safeToCleanup, true);

const untaggedKnownSecret = classifier.classify({ resourceKey: "secret", name: `deployguard/${projectId}/dev/DB_PASSWORD`, resourceType: "secret", awsService: "secretsmanager", region: "us-east-1", source: "naming_prefix" }, projects);
assert.equal(untaggedKnownSecret.safeToCleanup, false, "Known project resources require ownership tags for central automatic cleanup");

const orphanId = "7672125f-f3b1-42e5-861c-455c0f722897";
const exactOrphan = classifier.classify({ resourceKey: "orphan", name: `/deployguard/${orphanId}/dev/app`, resourceType: "log_group", awsService: "logs", region: "us-east-1", source: "naming_prefix" }, projects);
assert.equal(exactOrphan.status, "orphan");
assert.equal(exactOrphan.safeToCleanup, true);

const bucket = classifier.classify({ resourceKey: "bucket", name: "deployguard-state-bucket", resourceType: "state_bucket", awsService: "s3", region: "us-east-1", source: "state_backend" }, projects);
assert.equal(bucket.protected, true);
assert.equal(bucket.safeToCleanup, false);

const nat = classifier.classify({ resourceKey: "nat", name: "nat-123", resourceType: "nat_gateway", awsService: "ec2", region: "us-east-1", source: "discovered_tag", tags: { ManagedBy: "DeployGuard", ProjectId: projectId } }, projects);
assert.equal(nat.costRisk, "high");
assert.equal(nat.safeToCleanup, false, "Network cleanup remains manual even with exact ownership tags");

const terraformNat = classifier.classify({ resourceKey: "terraform-nat", name: "nat-terraform", resourceType: "nat_gateway", awsService: "ec2", region: "us-east-1", source: "terraform", projectId, tags: { ManagedBy: "DeployGuard", ProjectId: projectId, Environment: "dev" } }, projects);
assert.equal(terraformNat.status, "cleanup_required");
assert.equal(terraformNat.safeToCleanup, false, "Terraform dependencies must never be directly deleted");
assert.equal(terraformNat.reason, "Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues.");

const sharedEcr = classifier.classify({ resourceKey: "ecr", name: "mini-paas-shared", resourceType: "ecr_repository", awsService: "ecr", region: "us-east-1", source: "sdk", projectId, tags: { ManagedBy: "DeployGuard", ProjectId: projectId }, metadata: { shared: true } }, projects);
assert.equal(sharedEcr.protected, true);
assert.equal(sharedEcr.safeToCleanup, false);

const staleLock = classifier.classify({ resourceKey: "lock", name: `projects/${projectId}/terraform.dev.tfstate.tflock`, resourceType: "terraform_lockfile", awsService: "s3", region: "us-east-1", source: "state_backend", projectId, metadata: { stale: true } }, projects);
assert.equal(staleLock.safeToCleanup, true);

const safeRow = Object.assign(new CentralCloudResource(), { ...taggedLog, resourceName: taggedLog.name, resourceType: taggedLog.resourceType, arn: null, protected: false, cleanupSupported: true, safeToCleanup: true, projectId });
safety.assertCleanupAllowed(safeRow);
const protectedRow = Object.assign(new CentralCloudResource(), { ...safeRow, protected: true });
assert.throws(() => safety.assertCleanupAllowed(protectedRow), /protected/i);

const AdminGuard = requireRole([UserRole.ADMIN]);
const guard = new AdminGuard();
const contextFor = (role: UserRole) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }) as any;
assert.throws(() => guard.canActivate(contextFor(UserRole.DEVELOPER)), /Insufficient permissions/);
assert.equal(guard.canActivate(contextFor(UserRole.ADMIN)), true);

console.log("Central cloud cleanup safety verification passed: protected/shared, uncertain, untagged, and unsupported resources are non-destructive.");
