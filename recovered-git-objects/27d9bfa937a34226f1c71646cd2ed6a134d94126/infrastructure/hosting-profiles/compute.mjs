import { addResource, baseTerraform, boundedNumber, environmentReferences, exactKeys, finish, item, json, literal, ownershipTags, reference, requireValue, resourceName, secretReferences, text, uuid, validateScope } from './contracts.mjs';

function image(value, scope, privateAllowed) {
  text(value, /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9_./-]{0,180}@sha256:[a-f0-9]{64}$/, 'digest-pinned image');
  requireValue(!value.includes('..') && !value.includes('//'), 'Invalid image repository.');
  if (value.includes('.dkr.ecr.')) {
    requireValue(privateAllowed && value.startsWith(`${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com/dg-${scope.projectId.replaceAll('-', '').slice(0, 12)}-`), 'A private image must belong to the approved project and account.');
  } else requireValue(value.startsWith('public.ecr.aws/'), 'Public image ownership and supply-chain verification are required; only verified public ECR images are supported.');
  return value;
}
function dns(config, scope) {
  exactKeys(config, ['zoneId', 'zoneName'], 'DNS configuration');
  text(config?.zoneId, /^Z[A-Z0-9]{4,32}$/, 'DNS zone');
  text(config.zoneName, /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'public DNS zone name');
  requireValue(config.zoneName.split('.').length >= 2 && config.zoneName.length <= 190, 'Invalid DNS zone name.');
  const domain = `g-${scope.generationId.replaceAll('-', '').slice(0, 12)}.${config.zoneName}`;
  return { ...config, domain };
}
function vmConfiguration(input, scope, profile) {
  const config = input.configuration;
  exactKeys(config, ['availability', 'replicas', 'localPersistence', 'services', 'entrypointServiceId', 'healthPath', 'proxy', 'architecture', 'dns', 'ami', 'instanceType', 'vpcId', 'subnetId', 'rootStorageGiB', 'instanceCpu', 'instanceMemoryMiB', 'blueprint', 'bundle', 'availabilityZone'], 'VM configuration');
  requireValue(config?.availability === 'single_instance' && config.replicas === 1, 'Only explicitly approved single-instance VM generations are implemented.');
  requireValue(config.localPersistence === false && input.plan.assumptions?.stateful === false, 'VM-local durable application data is not supported; existing database attachments must remain external and retained.');
  requireValue(Array.isArray(config.services) && config.services.length > 0 && config.services.length <= (profile === 'lightsail' ? 1 : 10), 'Invalid VM service topology.');
  const ids = new Set();
  const services = config.services.map((s, index) => {
    exactKeys(s, ['id', 'port', 'cpu', 'memoryMiB', 'publicEnvironment', 'secretReferences', 'image', 'runAs'], 'service configuration');
    uuid(s.id, 'service ID'); requireValue(!ids.has(s.id), 'Duplicate service.'); ids.add(s.id);
    const admitted = input.plan.services?.find((p) => p.id === s.id);
    requireValue(admitted && admitted.port === s.port && admitted.buildTarget?.status === 'resolved' && admitted.buildTarget.sourceSha === scope.sourceSha, 'Service source and port must match the exact-SHA build target.');
    requireValue((admitted.buildTarget.architecture || admitted.buildTarget.evidence?.architecture || config.architecture) === config.architecture, 'Container architecture must match the verified VM architecture.');
    boundedNumber(s.port, 1024, 65535, 'application port', true); boundedNumber(s.cpu, .1, 32, 'CPU'); boundedNumber(s.memoryMiB, 64, 131072, 'memory', true);
    const publicEnvironment = environmentReferences(s.publicEnvironment);
    const secrets = secretReferences(s.secretReferences, scope);
    requireValue(Object.keys(publicEnvironment).every((key) => !secrets.some((v) => v.key === key)), 'A public value cannot override a secret reference.');
    if (profile === 'lightsail') requireValue(secrets.length === 0 && !input.plan.dependencies?.database, 'Lightsail has no approved instance IAM secret transport or database attachment contract.');
    image(s.image, scope, profile === 'ec2');
    text(s.runAs, /^\d{1,5}:\d{1,5}$/, 'container UID:GID'); requireValue(!s.runAs.startsWith('0:') && !s.runAs.endsWith(':0'), 'Application containers must run as a non-root user.');
    return { ...s, publicEnvironment, secretReferences: secrets, name: `dg-app-${index}` };
  });
  requireValue(input.plan.services.length === services.length, 'Every approved service must have a runtime artifact.');
  uuid(config.entrypointServiceId, 'entrypoint service'); requireValue(ids.has(config.entrypointServiceId), 'Entrypoint service is outside the approved generation.');
  text(config.healthPath, /^\/(?:[A-Za-z0-9_~.-]+\/?)*$/, 'health path');
  requireValue(!config.healthPath.split('/').some((p) => p === '..' || p === '.') && config.healthPath.length <= 200, 'Invalid health path.');
  const proxy = config.proxy;
  exactKeys(proxy, ['kind', 'image', 'verifiedDigest'], 'TLS proxy');
  requireValue(proxy?.kind === 'caddy' && proxy.verifiedDigest === true, 'A verified digest-pinned Caddy proxy is required for TLS.');
  image(proxy.image, scope, profile === 'ec2');
  requireValue(['amd64', 'arm64'].includes(config.architecture), 'Invalid VM architecture.');
  return { ...config, services, dns: dns(config.dns, scope), scope, profile };
}

// Values are data in a base64 JSON document, never interpolated into shell commands.
// Secrets are resolved only on EC2 through its project-scoped instance profile.
export function vmBootstrap(config) {
  const runtime = { scope: config.scope, profile: config.profile, services: config.services, proxy: { image: config.proxy.image }, dns: { domain: config.dns.domain }, ...(config.logGroup ? { logGroup: config.logGroup } : {}) };
  const payload = Buffer.from(JSON.stringify(runtime)).toString('base64');
  const installer = config.profile === 'ec2'
    ? 'dnf install -y docker python3 awscli2\nsystemctl enable --now docker'
    : 'export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y docker.io python3\nsystemctl enable --now docker';
  return `#!/bin/bash
set -euo pipefail
umask 077
${installer}
install -d -m 700 /opt/deployguard /run/deployguard
python3 - <<'DG_BOOTSTRAP'
import base64,json,pathlib
config=json.loads(base64.b64decode('${payload}'))
pathlib.Path('/opt/deployguard/config.json').write_text(json.dumps(config))
DG_BOOTSTRAP
cat > /opt/deployguard/start.py <<'DG_RUNTIME'
import json,os,pathlib,subprocess,sys,time
config=json.loads(pathlib.Path('/opt/deployguard/config.json').read_text())
scope=config['scope']; env=os.environ.copy(); env['AWS_DEFAULT_REGION']=scope['region']
def run(args, capture=False):
    proc=subprocess.run(args,env=env,text=True,capture_output=True)
    if proc.returncode: raise RuntimeError('Runtime command failed: '+args[0])
    return proc.stdout if capture else None
pathlib.Path('/run/deployguard').mkdir(mode=0o700,exist_ok=True)
os.chmod('/run/deployguard',0o700)
run(['docker','network','create','--label','ManagedBy=DeployGuard','dg-runtime']) if subprocess.run(['docker','network','inspect','dg-runtime'],capture_output=True).returncode else None
images=[s['image'] for s in config['services']]+[config['proxy']['image']]
registries=sorted(set(i.split('/')[0] for i in images if '.dkr.ecr.' in i))
for registry in registries:
    password=run(['aws','ecr','get-login-password','--region',scope['region']],True)
    auth=subprocess.run(['docker','login','--username','AWS','--password-stdin',registry],input=password,text=True,capture_output=True)
    if auth.returncode: raise RuntimeError('Registry authentication failed')
for img in images: run(['docker','pull',img])
for registry in registries: run(['docker','logout',registry])
for service in config['services']:
    values=dict(service['publicEnvironment'])
    for ref in service['secretReferences']:
        raw=run(['aws','secretsmanager','get-secret-value','--secret-id',ref['arn'],'--version-id',ref['versionId'],'--output','json'],True)
        value=json.loads(raw).get('SecretString')
        if not isinstance(value,str) or any(c in value for c in ['\\n','\\r','\\x00']): raise RuntimeError('Unsupported secret representation')
        values[ref['key']]=value
    values['PORT']=str(service['port'])
    path=pathlib.Path('/run/deployguard/'+service['name']+'.env')
    path.write_text(''.join(k+'='+v+'\\n' for k,v in values.items())); os.chmod(path,0o600)
    subprocess.run(['docker','rm','-f',service['name']],capture_output=True)
    args=['docker','run','-d','--name',service['name'],'--network','dg-runtime','--restart','unless-stopped','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',service['runAs'],'--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--cpus',str(service['cpu']),'--memory',str(service['memoryMiB'])+'m','--pids-limit','256','--env-file',str(path),'--label','ManagedBy=DeployGuard','--label','ProjectId='+scope['projectId'],'--label','GenerationId='+scope['generationId']]
    if config['profile']=='ec2': args+=['--log-driver','awslogs','--log-opt','awslogs-region='+scope['region'],'--log-opt','awslogs-group='+config['logGroup'],'--log-opt','awslogs-stream='+service['name'],'--log-opt','awslogs-create-stream=true']
    args.append(service['image']); run(args)
    path.unlink()
entry=next(s for s in config['services'] if s['id']==config['entrypointServiceId'])
proof=json.dumps({k:scope[k] for k in ['projectId','generationId','sourceSha','planFingerprint']},separators=(',',':'))
caddy=config['dns']['domain']+' {\\n handle /__deployguard_identity {\\n  header Content-Type application/json\\n  respond '+json.dumps(proof)+' 200\\n }\\n handle {\\n  reverse_proxy '+entry['name']+':'+str(entry['port'])+'\\n }\\n}\\n'
pathlib.Path('/opt/deployguard/Caddyfile').write_text(caddy)
subprocess.run(['docker','rm','-f','dg-tls'],capture_output=True)
run(['docker','run','-d','--name','dg-tls','--network','dg-runtime','--restart','unless-stopped','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges','--memory','256m','--cpus','0.25','--pids-limit','128','-p','80:80','-p','443:443','-v','/opt/deployguard/Caddyfile:/etc/caddy/Caddyfile:ro','-v','dg-tls-data:/data','-v','dg-tls-config:/config','--label','ManagedBy=DeployGuard',config['proxy']['image']])
DG_RUNTIME
cat > /etc/systemd/system/deployguard-runtime.service <<'DG_UNIT'
[Unit]
Description=DeployGuard immutable generation containers
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
UMask=0077
ExecStart=/usr/bin/python3 /opt/deployguard/start.py
TimeoutStartSec=600
Restart=on-failure
RestartSec=15
[Install]
WantedBy=multi-user.target
DG_UNIT
systemctl daemon-reload
systemctl enable --now deployguard-runtime.service
`;
}

function generationDns(tf, config, address) {
  tf.data.aws_route53_zone = { approved: { zone_id: config.dns.zoneId } };
  addResource(tf, 'aws_route53_record', 'candidate', { zone_id: config.dns.zoneId, name: config.dns.domain, type: 'A', ttl: 60, records: [reference(address)], allow_overwrite: false,
    lifecycle: { precondition: [{ condition: reference(`data.aws_route53_zone.approved.private_zone == false && trimsuffix(data.aws_route53_zone.approved.name, ".") == "${config.dns.zoneName}"`), error_message: 'The candidate DNS zone must be the approved public zone.' }] } });
}
export function buildEc2(input) {
  const s = validateScope(input, 'ec2'), c = vmConfiguration(input, s, 'ec2'), name = resourceName(s), tf = baseTerraform(s), tags = ownershipTags(s);
  exactKeys(c.ami, ['id', 'ownerId', 'os', 'architecture'], 'AMI evidence');
  text(c.ami?.id, /^ami-[a-f0-9]{8,17}$/, 'verified AMI'); text(c.ami.ownerId, /^\d{12}$/, 'AMI owner');
  requireValue(c.ami.os === 'amazon_linux_2023' && c.ami.architecture === (c.architecture === 'amd64' ? 'x86_64' : 'arm64'), 'The bootstrap requires an explicitly verified Amazon Linux 2023 AMI and matching architecture.');
  text(c.instanceType, /^[a-z][a-z0-9]*\.[a-z0-9]+$/, 'instance SKU'); text(c.vpcId, /^vpc-[a-f0-9]{8,17}$/, 'VPC'); text(c.subnetId, /^subnet-[a-f0-9]{8,17}$/, 'subnet');
  requireValue(input.plan.infrastructure?.vpcId === c.vpcId && input.plan.infrastructure?.publicSubnetIds?.includes(c.subnetId) && input.plan.infrastructure?.terraformStateBucket === s.stateBucket, 'The VM network and state backend differ from the approved plan.');
  boundedNumber(c.rootStorageGiB, 8, 1024, 'encrypted root storage', true); boundedNumber(c.instanceCpu, 1, 128, 'verified instance CPU'); boundedNumber(c.instanceMemoryMiB, 512, 524288, 'verified instance memory');
  requireValue(c.services.reduce((n, service) => n + service.cpu, .25) <= c.instanceCpu && c.services.reduce((n, service) => n + service.memoryMiB, 384) <= c.instanceMemoryMiB, 'The VM must reserve CPU and memory for TLS and its operating system.');
  c.logGroup = `/deployguard/${s.organizationId}/${s.projectId}/${s.environment}/${s.generationId}`;
  tf.data.aws_ami = { approved: { owners: [c.ami.ownerId], filter: [{ name: 'image-id', values: [c.ami.id] }, { name: 'architecture', values: [c.ami.architecture] }, { name: 'state', values: ['available'] }] } };
  tf.data.aws_subnet = { approved: { id: c.subnetId } };
  tf.data.aws_ec2_instance_type = { approved: { instance_type: c.instanceType } };
  addResource(tf, 'aws_cloudwatch_log_group', 'runtime', { name: c.logGroup, retention_in_days: 30, tags });
  const statements = [ { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: reference('"${aws_cloudwatch_log_group.runtime.arn}:*"') } ];
  // IAM JSON is assembled as a Terraform jsonencode expression for generated ARNs.
  const privateImages = [...c.services.map((v) => v.image), c.proxy.image].filter((v) => v.includes('.dkr.ecr.'));
  if (privateImages.length) {
    statements.push({ Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' });
    statements.push({ Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], Resource: [...new Set(privateImages.map((v) => `arn:aws:ecr:${s.region}:${s.accountId}:repository/${v.split('/').slice(1).join('/').split('@')[0]}`))] });
  }
  const secrets = c.services.flatMap((v) => v.secretReferences);
  if (secrets.length) statements.push({ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [...new Set(secrets.map((v) => v.arn))] });
  // References are intentionally represented inside a jsonencode expression, not escaped literals.
  statements[0].Resource = reference('aws_cloudwatch_log_group.runtime.arn') + ':*';
  addResource(tf, 'aws_iam_role', 'runtime', { name, assume_role_policy: json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }), tags });
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  addResource(tf, 'aws_iam_role_policy', 'runtime', { name, role: reference('aws_iam_role.runtime.id'), policy });
  addResource(tf, 'aws_iam_instance_profile', 'runtime', { name, role: reference('aws_iam_role.runtime.name'), tags });
  addResource(tf, 'aws_security_group', 'runtime', { name, description: 'Candidate generation HTTPS and ACME only; no public application or SSH port', vpc_id: c.vpcId, tags });
  for (const port of [80, 443]) addResource(tf, 'aws_vpc_security_group_ingress_rule', `https_${port}`, { security_group_id: reference('aws_security_group.runtime.id'), from_port: port, to_port: port, ip_protocol: 'tcp', cidr_ipv4: '0.0.0.0/0', tags });
  addResource(tf, 'aws_vpc_security_group_egress_rule', 'outbound', { security_group_id: reference('aws_security_group.runtime.id'), ip_protocol: '-1', cidr_ipv4: '0.0.0.0/0', tags });
  const bootstrap = vmBootstrap(c);
  requireValue(Buffer.byteLength(bootstrap) <= 16384, 'The generated VM user data exceeds the EC2 limit.');
  addResource(tf, 'aws_instance', 'runtime', { ami: reference('data.aws_ami.approved.id'), instance_type: c.instanceType, subnet_id: c.subnetId, associate_public_ip_address: true, vpc_security_group_ids: [reference('aws_security_group.runtime.id')], iam_instance_profile: reference('aws_iam_instance_profile.runtime.name'), user_data_base64: Buffer.from(bootstrap).toString('base64'), user_data_replace_on_change: true, monitoring: true, tags,
    metadata_options: { http_endpoint: 'enabled', http_tokens: 'required', http_put_response_hop_limit: 1, instance_metadata_tags: 'disabled' }, root_block_device: { encrypted: true, volume_type: 'gp3', volume_size: c.rootStorageGiB, delete_on_termination: true, tags },
    depends_on: ['aws_iam_role_policy.runtime', 'aws_cloudwatch_log_group.runtime'], lifecycle: { precondition: [
      { condition: reference(`data.aws_subnet.approved.vpc_id == "${c.vpcId}" && data.aws_subnet.approved.owner_id == "${s.accountId}"`), error_message: 'Subnet account and VPC must match the approved scope.' },
      { condition: reference(`contains(data.aws_ec2_instance_type.approved.supported_architectures, "${c.ami.architecture}") && data.aws_ec2_instance_type.approved.default_vcpus == ${c.instanceCpu} && data.aws_ec2_instance_type.approved.memory_size == ${c.instanceMemoryMiB}`), error_message: 'Verified instance architecture or capacity changed.' },
    ] } });
  addResource(tf, 'aws_eip', 'runtime', { domain: 'vpc', instance: reference('aws_instance.runtime.id'), tags }); generationDns(tf, c, 'aws_eip.runtime.public_ip');
  tf.output.runtime_identity = { value: { instanceId: reference('aws_instance.runtime.id'), elasticIpAllocationId: reference('aws_eip.runtime.id'), endpoint: `https://${c.dns.domain}`, serviceIds: c.services.map((v) => v.id), architecture: c.architecture, sourceSha: s.sourceSha, generationId: s.generationId } };
  return finish(input, s, tf, { 'bootstrap.sh': bootstrap }, [item('compute', 'AmazonEC2', c.instanceType, 730, 'hours'), item('storage', 'AmazonEC2', 'gp3', c.rootStorageGiB, 'GiB-month'), item('network', 'AmazonVPC', 'public IPv4', 730, 'hours'), item('requests', 'AmazonRoute53', 'DNS queries', input.plan.assumptions.monthlyRequests, 'queries', 'variable'), item('data_transfer', 'AmazonEC2', 'Internet egress', input.plan.assumptions.monthlyTransferGiB, 'GiB', 'variable'), item('monitoring', 'AmazonCloudWatch', 'logs and detailed metrics', input.plan.assumptions.monthlyLogGiB, 'GiB', 'variable')],
    { architecture: c.architecture, os: c.ami.os, topology: 'single_instance', durableData: 'external_retained', tls: 'generation_dns_acme', healthPath: c.healthPath, limitations: ['Single instance has no automatic multi-zone failover.', 'OS and pinned container updates require a new approved generation.', 'Ephemeral application filesystem; no automatic database migration.'] }, tf.output.runtime_identity.value);
}
export function buildLightsail(input) {
  const s = validateScope(input, 'lightsail'), c = vmConfiguration(input, s, 'lightsail'), name = resourceName(s), tf = baseTerraform(s), tags = ownershipTags(s);
  exactKeys(c.blueprint, ['id', 'os'], 'blueprint evidence'); exactKeys(c.bundle, ['id', 'cpu', 'memoryMiB', 'storageGiB', 'includedTransferGiB', 'overagePricingRequired'], 'bundle evidence');
  text(c.blueprint?.id, /^[A-Za-z0-9_\-.]{1,100}$/, 'verified Lightsail blueprint'); requireValue(c.blueprint.os === 'ubuntu_22_04' && c.architecture === 'amd64', 'The Lightsail bootstrap requires a verified Ubuntu 22.04 x86_64 blueprint.');
  text(c.bundle?.id, /^[A-Za-z0-9_\-.]{1,100}$/, 'verified Lightsail bundle'); text(c.availabilityZone, new RegExp(`^${s.region}[a-z]$`), 'availability zone');
  boundedNumber(c.bundle.cpu, 1, 64, 'bundle CPU'); boundedNumber(c.bundle.memoryMiB, 512, 131072, 'bundle memory'); boundedNumber(c.bundle.storageGiB, 8, 4096, 'bundle storage');
  boundedNumber(c.bundle.includedTransferGiB, 0, 100000, 'included transfer');
  requireValue(c.services[0].cpu + .25 <= c.bundle.cpu && c.services[0].memoryMiB + 384 <= c.bundle.memoryMiB && input.plan.assumptions.storageGiB <= c.bundle.storageGiB, 'The approved Lightsail bundle lacks capacity for the workload and TLS.');
  requireValue(input.plan.assumptions.monthlyTransferGiB <= c.bundle.includedTransferGiB || c.bundle.overagePricingRequired === true, 'Transfer beyond the bundle requires explicit regional overage pricing.');
  const bootstrap = vmBootstrap(c);
  requireValue(Buffer.byteLength(bootstrap) <= 16384, 'The generated Lightsail user data exceeds the supported bound.');
  addResource(tf, 'aws_lightsail_instance', 'runtime', { name, availability_zone: c.availabilityZone, blueprint_id: c.blueprint.id, bundle_id: c.bundle.id, ip_address_type: 'ipv4', user_data: literal(bootstrap), tags });
  addResource(tf, 'aws_lightsail_instance_public_ports', 'runtime', { instance_name: reference('aws_lightsail_instance.runtime.name'), port_info: [80, 443].map((port) => ({ from_port: port, to_port: port, protocol: 'tcp', cidrs: ['0.0.0.0/0'] })) });
  addResource(tf, 'aws_lightsail_static_ip', 'runtime', { name });
  addResource(tf, 'aws_lightsail_static_ip_attachment', 'runtime', { static_ip_name: reference('aws_lightsail_static_ip.runtime.name'), instance_name: reference('aws_lightsail_instance.runtime.name') }); generationDns(tf, c, 'aws_lightsail_static_ip.runtime.ip_address');
  tf.output.runtime_identity = { value: { instanceArn: reference('aws_lightsail_instance.runtime.arn'), instanceName: name, staticIpName: name, endpoint: `https://${c.dns.domain}`, serviceIds: c.services.map((v) => v.id), sourceSha: s.sourceSha, generationId: s.generationId } };
  return finish(input, s, tf, { 'bootstrap.sh': bootstrap }, [item('compute', 'AmazonLightsail', c.bundle.id, 1, 'bundle-month'), item('storage', 'AmazonLightsail', 'bundle disk and required recovery snapshots', c.bundle.storageGiB, 'GiB-month'), item('network', 'AmazonLightsail', 'attached or idle static IPv4', 730, 'hours'), item('requests', 'AmazonRoute53', 'DNS queries', input.plan.assumptions.monthlyRequests, 'queries', 'variable'), item('data_transfer', 'AmazonLightsail', 'regional bundle allowance and overage', input.plan.assumptions.monthlyTransferGiB, 'GiB', 'variable'), item('monitoring', 'AmazonLightsail', 'instance metrics and local log retention', input.plan.assumptions.monthlyLogGiB, 'GiB', 'variable')],
    { architecture: c.architecture, os: c.blueprint.os, topology: 'single_instance', tls: 'generation_dns_acme', healthPath: c.healthPath, limitations: ['Public digest-pinned images only; no instance IAM or private registry credentials.', 'Secret environment variables and database attachments are unsupported.', 'No multi-service scaling, persistent application disk or multi-zone failover.', 'Local container logs require operator retention; no remote logs authority is assumed.'] }, tf.output.runtime_identity.value);
}
