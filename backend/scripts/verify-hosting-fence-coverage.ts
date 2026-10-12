// Static check that each hosting profile's session fence allows every IAM action the AWS provider (5.100.0)
// calls to create, read and destroy the Terraform that profile generates. Live runs found these gaps one
// deploy at a time and left half-cleaned resources; this surfaces them locally for create and destroy alike.
// Usage: npm run test:hosting-fence-coverage
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { hostingProviderSessionPolicy } from "../src/planning/hosting-provider-session.service";

const importModule = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const account = "123456789012", region = "us-east-1";
const ids = { organizationId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", bindingId: "33333333-3333-4333-8333-333333333333",
  operationId: "44444444-4444-4444-8444-444444444444", generationId: "55555555-5555-4555-8555-555555555555", planId: "66666666-6666-4666-8666-666666666666" };
const serviceId = "77777777-7777-4777-8777-777777777777", sourceSha = "a".repeat(40), stateBucket = "dg-state-bucket";
const image = (repo: string) => `public.ecr.aws/${repo}@sha256:${"c".repeat(64)}`;
const zone = { zoneId: "Z07090762TC6WBRAAVN8R", zoneName: "test.deployguard.me" };

type Ctx = { name: string; bucket: string; log: (group: string) => string };
// Provider calls per resource type. `arn` narrows the check to the concrete resource the generation owns.
type Need = { actions: string[]; arn?: (c: Ctx, body: any) => string; when?: (body: any) => boolean; note?: string };
const r = (actions: string[], arn?: Need["arn"]): Need => ({ actions, arn });
const role = (c: Ctx) => `arn:aws:iam::${account}:role/${c.name}`;
const bucket = (c: Ctx) => `arn:aws:s3:::${c.bucket}`;
const objects = (c: Ctx) => `arn:aws:s3:::${c.bucket}/generations/${ids.generationId}/x`;
const fn = (c: Ctx) => `arn:aws:lambda:${region}:${account}:function:${c.name}`;
const REQUIRED: Record<string, Need[]> = {
  "data.aws_caller_identity": [], // sts:GetCallerIdentity needs no permission
  "data.aws_ami": [r(["ec2:DescribeImages"])],
  "data.aws_subnet": [r(["ec2:DescribeSubnets"])],
  "data.aws_ec2_instance_type": [r(["ec2:DescribeInstanceTypes"])],
  "data.aws_route53_zone": [r(["route53:GetHostedZone", "route53:ListTagsForResource"], () => `arn:aws:route53:::hostedzone/${zone.zoneId}`), r(["route53:ListHostedZones"])],
  aws_route53_record: [r(["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"], () => `arn:aws:route53:::hostedzone/${zone.zoneId}`), r(["route53:GetChange"], () => "arn:aws:route53:::change/C1")],
  aws_cloudwatch_log_group: [r(["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:ListTagsForResource", "logs:DeleteLogGroup"], (c, b) => c.log(b.name)), r(["logs:DescribeLogGroups"])],
  aws_iam_role: [r(["iam:CreateRole", "iam:GetRole", "iam:TagRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:DeleteRole"], role)],
  aws_iam_role_policy: [r(["iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy"], role)],
  aws_iam_instance_profile: [r(["iam:CreateInstanceProfile", "iam:GetInstanceProfile", "iam:TagInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:DeleteInstanceProfile"], (c) => `arn:aws:iam::${account}:instance-profile/${c.name}`), r(["iam:PassRole"], role)],
  aws_instance: [r(["ec2:RunInstances", "ec2:CreateTags", "ec2:DescribeInstances", "ec2:DescribeInstanceAttribute", "ec2:DescribeInstanceCreditSpecifications", "ec2:DescribeVolumes", "ec2:TerminateInstances"]), { actions: ["ec2:MonitorInstances"], when: (b) => b.monitoring === true }],
  aws_eip: [r(["ec2:AllocateAddress", "ec2:DescribeAddresses", "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:ReleaseAddress"])],
  aws_security_group: [r(["ec2:CreateSecurityGroup", "ec2:DescribeSecurityGroups", "ec2:RevokeSecurityGroupEgress", "ec2:DeleteSecurityGroup"])],
  aws_vpc_security_group_ingress_rule: [r(["ec2:AuthorizeSecurityGroupIngress", "ec2:DescribeSecurityGroupRules", "ec2:RevokeSecurityGroupIngress"])],
  aws_vpc_security_group_egress_rule: [r(["ec2:AuthorizeSecurityGroupEgress", "ec2:DescribeSecurityGroupRules", "ec2:RevokeSecurityGroupEgress"])],
  aws_lightsail_instance: [r(["lightsail:CreateInstances", "lightsail:TagResource", "lightsail:GetInstance", "lightsail:GetOperation", "lightsail:DeleteInstance"])],
  aws_lightsail_instance_public_ports: [r(["lightsail:PutInstancePublicPorts", "lightsail:GetInstancePortStates", "lightsail:CloseInstancePublicPorts"])],
  aws_lightsail_static_ip: [r(["lightsail:AllocateStaticIp", "lightsail:GetStaticIp", "lightsail:ReleaseStaticIp"])],
  aws_lightsail_static_ip_attachment: [r(["lightsail:AttachStaticIp", "lightsail:GetStaticIp", "lightsail:DetachStaticIp"])],
  aws_s3_bucket: [r(["s3:CreateBucket", "s3:PutBucketTagging", "s3:ListBucket", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging", "s3:GetBucketPolicy", "s3:DeleteBucket"], bucket)],
  aws_s3_bucket_public_access_block: [r(["s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock"], bucket)],
  aws_s3_bucket_ownership_controls: [r(["s3:PutBucketOwnershipControls", "s3:GetBucketOwnershipControls"], bucket)],
  aws_s3_bucket_versioning: [r(["s3:PutBucketVersioning", "s3:GetBucketVersioning"], bucket)],
  aws_s3_bucket_server_side_encryption_configuration: [r(["s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration"], bucket)],
  aws_s3_bucket_policy: [r(["s3:PutBucketPolicy", "s3:GetBucketPolicy", "s3:DeleteBucketPolicy"], bucket)],
  // Versioned buckets: destroy removes the generation's object versions before the bucket.
  aws_s3_object: [r(["s3:PutObject", "s3:GetObject", "s3:GetObjectTagging", "s3:PutObjectTagging", "s3:DeleteObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"], objects), r(["s3:ListBucketVersions"], bucket)],
  aws_cloudfront_origin_access_control: [r(["cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:DeleteOriginAccessControl"])],
  aws_cloudfront_distribution: [r(["cloudfront:CreateDistribution", "cloudfront:TagResource", "cloudfront:GetDistribution", "cloudfront:ListTagsForResource", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution"])],
  aws_lambda_function: [r(["lambda:CreateFunction", "lambda:GetFunction", "lambda:ListVersionsByFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:ListTags", "lambda:TagResource", "lambda:PublishVersion", "lambda:DeleteFunction"], fn), r(["iam:PassRole"], role),
    { actions: ["lambda:PutFunctionConcurrency", "lambda:GetFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], arn: fn, when: (b) => b.reserved_concurrent_executions !== undefined }],
  aws_lambda_alias: [r(["lambda:CreateAlias", "lambda:GetAlias", "lambda:DeleteAlias"], fn)],
  aws_lambda_permission: [r(["lambda:AddPermission", "lambda:GetPolicy", "lambda:RemovePermission"], fn)],
  aws_apigatewayv2_api: [r(["apigateway:POST", "apigateway:GET", "apigateway:TagResource", "apigateway:DELETE"], () => `arn:aws:apigateway:${region}::/apis/a1`)],
  aws_apigatewayv2_integration: [r(["apigateway:POST", "apigateway:GET", "apigateway:DELETE"], () => `arn:aws:apigateway:${region}::/apis/a1/integrations/i1`)],
  aws_apigatewayv2_route: [r(["apigateway:POST", "apigateway:GET", "apigateway:DELETE"], () => `arn:aws:apigateway:${region}::/apis/a1/routes/r1`)],
  aws_apigatewayv2_stage: [r(["apigateway:POST", "apigateway:GET", "apigateway:DELETE"], () => `arn:aws:apigateway:${region}::/apis/a1/stages/s1`),
    // CloudWatch vended log delivery; AWS documents these as account-wide (Resource "*").
    { actions: ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies"], when: (b) => Boolean(b.access_log_settings), note: "API Gateway stage access logging" }],
};

const glob = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(value);
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
// Conditions are deliberately ignored: this proves action/resource reachability, not tag scoping.
function allows(policy: any, action: string, arn?: string) {
  return policy.Statement.some((s: any) => s.Effect === "Allow" && list(s.Action).some((a) => glob(a, action)) && (!arn || list(s.Resource).some((res) => glob(res, arn))));
}

function input(profile: string) {
  const scope: any = { ...ids, accountId: account, region, environment: "staging", sourceSha, configurationFingerprint: "b".repeat(64), bindingVersion: 1, stateBucket };
  const vm = profile === "ec2" || profile === "lightsail";
  const build = (kind: string) => ({ sourceSha, kind, fingerprint: "e".repeat(64), securityScanFingerprint: "f".repeat(64), status: "verified" });
  const configuration: any = profile === "static"
    ? { build: build("static"), assets: [{ path: "index.html", bytes: 10, sha256: "d".repeat(64), contentType: "text/html" }], spa: true, priceClass: "PriceClass_100", healthPath: "/" }
    : vm ? { availability: "single_instance", replicas: 1, localPersistence: false, entrypointServiceId: serviceId, healthPath: "/", architecture: "amd64",
      services: [{ id: serviceId, port: 8080, cpu: .25, memoryMiB: 64, publicEnvironment: {}, secretReferences: [], image: image("nginx/nginx-unprivileged"), runAs: "101:101" }],
      proxy: { kind: "caddy", image: image("docker/library/caddy"), verifiedDigest: true }, dns: zone,
      ...(profile === "ec2" ? { ami: { id: "ami-0123456789abcdef0", ownerId: "137112412989", os: "amazon_linux_2023", architecture: "x86_64" }, instanceType: "t3.small", vpcId: "vpc-0123456789abcdef0", subnetId: "subnet-0123456789abcdef0", rootStorageGiB: 30, instanceCpu: 2, instanceMemoryMiB: 2048 }
        : { blueprint: { id: "ubuntu_22_04", os: "ubuntu_22_04" }, bundle: { id: "nano_3_0", cpu: 2, memoryMiB: 512, storageGiB: 20, includedTransferGiB: 1024, overagePricingRequired: true }, availabilityZone: "us-east-1a" }) }
      : { build: build("lambda_http"), serviceId, architecture: "amd64", runtime: "nodejs22.x", handler: "index.handler", artifact: { sha256: "d".repeat(64), bytes: 100, uncompressedBytes: 200 },
        adapter: { kind: "native_http", fingerprint: "d".repeat(64), payloadFormat: "2.0", timeoutBounded: true, filesystemEphemeral: true, backgroundWorkers: false, maximumRequestBytes: 65536, maximumResponseBytes: 65536 },
        publicEnvironment: {}, secretReferences: [], timeoutSeconds: 15, memoryMiB: 256, ephemeralStorageMiB: 512, reservedConcurrency: 0, requestsPerSecond: 10, burstLimit: 20, healthPath: "/health", authorization: "public_application_endpoint" };
  const plan = { projectId: ids.projectId, generationId: ids.generationId, operationId: ids.operationId, ownership: { organizationId: ids.organizationId, bindingId: ids.bindingId, bindingVersion: 1, accountId: account, region, environment: "staging" },
    repository: { sourceSha }, configurationFingerprint: scope.configurationFingerprint, selectedProfile: profile, profileInputs: configuration,
    assumptions: { stateful: false, continuousCompute: vm, storageGiB: 1, monthlyRequests: 1000, monthlyTransferGiB: 1, monthlyLogGiB: 1 },
    services: [{ id: serviceId, port: vm ? 8080 : 3000, buildTarget: { status: "resolved", sourceSha, architecture: "amd64" } }], environmentReferences: [], dependencies: { database: null },
    infrastructure: { vpcId: "vpc-0123456789abcdef0", publicSubnetIds: ["subnet-0123456789abcdef0"], terraformStateBucket: stateBucket }, status: "review_required", blockers: [] };
  return { profile, scope, plan, configuration };
}

async function main() {
  const root = resolve(__dirname, "../../infrastructure/hosting-profiles");
  const { buildHostingArtifacts } = await importModule(`${root}/index.mjs`);
  const { fingerprint } = await importModule(`${root}/contracts.mjs`);
  const gaps: string[] = [];
  for (const profile of ["ec2", "lightsail", "static", "lambda"]) {
    const value = input(profile);
    value.scope.planFingerprint = fingerprint(value.plan);
    const artifact = buildHostingArtifacts(value);
    const tf = JSON.parse(artifact.files["main.tf.json"]);
    const name = `dg-${ids.projectId.replaceAll("-", "").slice(0, 12)}-${ids.generationId.replaceAll("-", "").slice(0, 12)}`;
    const ctx: Ctx = { name, bucket: `${name}-${account}`, log: (group) => `arn:aws:logs:${region}:${account}:log-group:${group}` };
    const policy = hostingProviderSessionPolicy({ ...value.scope, profile, ...(profile === "ec2" || profile === "lightsail" ? { dnsZoneId: zone.zoneId, dnsRecordName: `g-${ids.generationId.replaceAll("-", "").slice(0, 12)}.${zone.zoneName}` } : {}) } as any);
    const blocks = [...Object.entries(tf.data || {}).map(([type, named]) => [`data.${type}`, named] as const), ...Object.entries(tf.resource).map(([type, named]) => [type, named] as const)];
    for (const [type, named] of blocks) {
      const needs = REQUIRED[type];
      assert(needs, `${profile}: no reviewed IAM requirements for Terraform type ${type}; add it to REQUIRED before generating it`);
      for (const body of Object.values(named as Record<string, any>)) for (const need of needs) {
        if (need.when && !need.when(body)) continue;
        const arn = need.arn?.(ctx, body);
        const missing = need.actions.filter((action) => !allows(policy, action, arn));
        if (missing.length) gaps.push(`${profile} ${type}${need.note ? ` (${need.note})` : ""}: ${missing.join(", ")}${arn ? ` on ${arn}` : ""}`);
      }
    }
  }
  const unique = [...new Set(gaps)];
  if (unique.length) { console.error(`Session fence gaps (${unique.length}):\n- ${unique.join("\n- ")}`); process.exit(1); }
  console.log("HOSTING_FENCE_COVERAGE=PASS PROFILES=4 create, read and destroy actions are allowed by each profile's session fence.");
}
void main().catch((error) => { console.error(error); process.exit(1); });
