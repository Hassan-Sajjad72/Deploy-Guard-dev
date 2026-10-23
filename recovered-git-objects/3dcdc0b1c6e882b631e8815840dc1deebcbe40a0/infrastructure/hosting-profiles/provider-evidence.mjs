import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { fingerprint, requireValue } from './contracts.mjs';
const execute = promisify(execFile);
function credentialEnvironment(session) {
  requireValue(session?.credentials?.sessionToken, 'A temporary customer provider session is required.');
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_'))), AWS_ACCESS_KEY_ID: session.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: session.credentials.secretAccessKey, AWS_SESSION_TOKEN: session.credentials.sessionToken, AWS_DEFAULT_REGION: session.region, AWS_REGION: session.region, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
}
export async function providerJson(session, args) {
  try {
    const response = await execute('aws', [...args, '--output', 'json', '--no-cli-pager'], { env: credentialEnvironment(session), timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(response.stdout);
  } catch { throw new Error('Fresh provider ownership evidence is unavailable.'); }
}
function tagsOwned(tags, manifest) {
  const values = Array.isArray(tags) ? Object.fromEntries(tags.map((v) => [v.Key ?? v.key, v.Value ?? v.value])) : tags || {};
  requireValue(Object.entries(manifest.ownershipTags).every(([key, value]) => values[key] === value), 'Provider resource ownership tags changed.');
}
export async function readProviderOwnership(manifest, identity, session, query = providerJson) {
  requireValue(session.accountId === manifest.scope.accountId && session.region === manifest.scope.region && identity.generationId === manifest.scope.generationId && identity.sourceSha === manifest.scope.sourceSha, 'Provider evidence scope changed.');
  const name = `dg-${manifest.scope.projectId.replaceAll('-', '').slice(0, 12)}-${manifest.scope.generationId.replaceAll('-', '').slice(0, 12)}`;
  const account = manifest.scope.accountId, region = manifest.scope.region;
  if (manifest.profile === 'ec2') {
    requireValue(/^i-[a-f0-9]{8,17}$/.test(identity.instanceId) && /^eipalloc-[a-f0-9]{8,17}$/.test(identity.elasticIpAllocationId), 'Invalid EC2 output identity.');
    const [instances, addresses, userData] = await Promise.all([
      query(session, ['ec2', 'describe-instances', '--instance-ids', identity.instanceId]),
      query(session, ['ec2', 'describe-addresses', '--allocation-ids', identity.elasticIpAllocationId]),
      query(session, ['ec2', 'describe-instance-attribute', '--instance-id', identity.instanceId, '--attribute', 'userData']),
    ]);
    const reservation = instances.Reservations?.[0], instance = reservation?.Instances?.[0], address = addresses.Addresses?.[0];
    requireValue(reservation?.OwnerId === account && instance?.InstanceId === identity.instanceId && instance.State?.Name === 'running' && instance.MetadataOptions?.HttpTokens === 'required' && address?.InstanceId === identity.instanceId && address.AllocationId === identity.elasticIpAllocationId, 'EC2 candidate account, instance, IMDS or address changed.');
    tagsOwned(instance.Tags, manifest); tagsOwned(address.Tags, manifest);
    requireValue(typeof userData.UserData?.Value === 'string' && createHash('sha256').update(Buffer.from(userData.UserData.Value, 'base64')).digest('hex') === manifest.files['bootstrap.sh'], 'EC2 immutable bootstrap changed.');
    await verifyDns(session, manifest, identity, address.PublicIp, query);
  } else if (manifest.profile === 'lightsail') {
    requireValue(identity.instanceName === name && identity.staticIpName === name && String(identity.instanceArn).startsWith(`arn:aws:lightsail:${region}:${account}:Instance/`), 'Invalid Lightsail candidate identity.');
    const [result, staticIp, ports] = await Promise.all([query(session, ['lightsail', 'get-instance', '--instance-name', name]), query(session, ['lightsail', 'get-static-ip', '--static-ip-name', name]), query(session, ['lightsail', 'get-instance-port-states', '--instance-name', name])]);
    requireValue(result.instance?.arn === identity.instanceArn && result.instance.name === name && result.instance.state?.name === 'running' && result.instance.isStaticIp === true && staticIp.staticIp?.attachedTo === name && staticIp.staticIp.ipAddress === result.instance.publicIpAddress, 'Lightsail instance or static address changed.');
    tagsOwned(result.instance.tags, manifest);
    requireValue(ports.portStates?.length === 2 && ports.portStates.every((v) => [80, 443].includes(v.fromPort) && v.toPort === v.fromPort && v.protocol === 'tcp' && v.state === 'open'), 'Lightsail public port scope changed.');
    await verifyDns(session, manifest, identity, staticIp.staticIp.ipAddress, query);
  } else if (manifest.profile === 'static') {
    requireValue(typeof identity.distributionId === 'string' && /^[A-Z0-9]{8,32}$/.test(identity.distributionId) && identity.bucket === `${name}-${account}` && identity.objectPrefix === `generations/${manifest.scope.generationId}/`, 'Invalid static generation identity.');
    const [distribution, tags, bucketTags] = await Promise.all([query(session, ['cloudfront', 'get-distribution', '--id', identity.distributionId]), query(session, ['cloudfront', 'list-tags-for-resource', '--resource', identity.distributionArn]), query(session, ['s3api', 'get-bucket-tagging', '--bucket', identity.bucket, '--expected-bucket-owner', account])]);
    const actual = distribution.Distribution;
    requireValue(actual?.ARN === identity.distributionArn && actual.ARN === `arn:aws:cloudfront::${account}:distribution/${identity.distributionId}` && actual.Status === 'Deployed' && actual.DistributionConfig?.Enabled && identity.endpoint === `https://${actual.DomainName}` && actual.DistributionConfig.Origins?.Items?.length === 1 && actual.DistributionConfig.Origins.Items[0].OriginPath === '/' + identity.objectPrefix.slice(0, -1) && actual.DistributionConfig.Origins.Items[0].DomainName.startsWith(identity.bucket + '.') && actual.DistributionConfig.DefaultCacheBehavior?.ViewerProtocolPolicy === 'redirect-to-https', 'Static distribution, origin or HTTPS routing changed.');
    tagsOwned(tags.Tags?.Items, manifest); tagsOwned(bucketTags.TagSet, manifest);
  } else if (manifest.profile === 'lambda') {
    requireValue(identity.functionArn === `arn:aws:lambda:${region}:${account}:function:${name}` && /^[1-9][0-9]*$/.test(String(identity.version)) && /^[a-z0-9]{1,20}$/.test(identity.apiId), 'Invalid Lambda identity.');
    const [result, alias, api, integrations, tags] = await Promise.all([query(session, ['lambda', 'get-function', '--function-name', name, '--qualifier', String(identity.version)]), query(session, ['lambda', 'get-alias', '--function-name', name, '--name', 'candidate']), query(session, ['apigatewayv2', 'get-api', '--api-id', identity.apiId]), query(session, ['apigatewayv2', 'get-integrations', '--api-id', identity.apiId]), query(session, ['lambda', 'list-tags', '--resource', identity.functionArn])]);
    const configuration = result.Configuration;
    requireValue(configuration?.FunctionArn === `${identity.functionArn}:${identity.version}` && configuration.CodeSha256 === Buffer.from(identity.artifactSha256, 'hex').toString('base64') && configuration.State === 'Active' && alias.AliasArn === identity.aliasArn && alias.FunctionVersion === String(identity.version) && api.ApiEndpoint === identity.endpoint && api.ProtocolType === 'HTTP' && integrations.Items?.length === 1 && integrations.Items[0].PayloadFormatVersion === '2.0' && integrations.Items[0].IntegrationUri?.includes(identity.aliasArn), 'Lambda code version or HTTP integration changed.');
    tagsOwned(tags.Tags, manifest); tagsOwned(api.Tags, manifest);
  } else throw new Error('Unsupported provider evidence profile.');
  return { status: 'verified', accountId: account, region, resourceFingerprint: fingerprint(identity), observedAt: new Date().toISOString() };
}
async function verifyDns(session, manifest, identity, address, query) {
  const endpoint = new URL(identity.endpoint);
  requireValue(endpoint.protocol === 'https:' && endpoint.hostname.startsWith(`g-${manifest.scope.generationId.replaceAll('-', '').slice(0, 12)}.`) && !endpoint.port && !endpoint.username && !endpoint.password && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash, 'Generation TLS endpoint changed.');
  const zoneId = manifest.dnsZoneId;
  requireValue(/^Z[A-Z0-9]{4,32}$/.test(zoneId || ''), 'The approved DNS zone evidence is required.');
  const records = await query(session, ['route53', 'list-resource-record-sets', '--hosted-zone-id', zoneId, '--start-record-name', endpoint.hostname, '--start-record-type', 'A', '--max-items', '1']);
  const record = records.ResourceRecordSets?.[0];
  requireValue(record?.Name === endpoint.hostname + '.' && record.Type === 'A' && record.ResourceRecords?.length === 1 && record.ResourceRecords[0].Value === address, 'Candidate DNS no longer routes to the verified provider address.');
}
function publicIp(address) {
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0); }
  const normalized = address.toLowerCase(); const special = normalized.startsWith('2001:') && (Number.parseInt(normalized.split(':')[1] || '0', 16) < 0x200 || normalized.startsWith('2001:db8:'));
  return isIP(address) === 6 && /^[23]/.test(normalized) && !normalized.startsWith('2002:') && !special;
}
async function boundedHttps(endpoint, path) {
  const url = new URL(endpoint); requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash && !isIP(url.hostname), 'A credential-free verified HTTPS origin is required.');
  requireValue(/^\/[A-Za-z0-9_./~-]*$/.test(path) && !path.split('/').some((v) => v === '..' || v === '.'), 'Unsafe health path.');
  let timeout; const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Health DNS deadline exceeded')), 5000); })]).finally(() => clearTimeout(timeout));
  requireValue(addresses.length && addresses.every((v) => publicIp(v.address)), 'Health DNS must resolve exclusively to public addresses.');
  let deadline;
  return new Promise((resolve, reject) => {
    const selected = addresses[0]; let size = 0; const chunks = [];
    const request = https.request({ hostname: url.hostname, port: 443, path, method: 'GET', agent: false, rejectUnauthorized: true, servername: url.hostname, headers: { Accept: 'application/json', 'User-Agent': 'DeployGuard-owned-generation-health' }, lookup: (_host, _options, callback) => callback(null, selected.address, selected.family) }, (response) => {
      response.on('data', (chunk) => { size += chunk.length; if (size > 65536) { response.destroy(); request.destroy(new Error('Health response exceeds bound')); } else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks) })); response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Health request deadline exceeded'))); request.on('error', reject); request.end();
    deadline = setTimeout(() => request.destroy(new Error('Health absolute deadline exceeded')), 5000);
  }).finally(() => clearTimeout(deadline));
}
export async function probeProviderHealth(manifest, identity, get = boundedHttps) {
  let last; const started = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      requireValue(Date.now() - started < 20000, 'Candidate health observation deadline exceeded.');
      const application = await get(identity.endpoint, manifest.compatibility.healthPath);
      requireValue(application.status >= 200 && application.status < 300, 'Candidate application health failed.');
      if (['ec2', 'lightsail'].includes(manifest.profile)) {
        const metadata = await get(identity.endpoint, '/__deployguard_identity'); const proof = JSON.parse(metadata.body.toString('utf8'));
        requireValue(metadata.status === 200 && ['projectId', 'generationId', 'sourceSha', 'planFingerprint'].every((key) => proof[key] === manifest.scope[key]), 'Candidate TLS proxy source evidence differs from the approved generation.');
      }
      return { status: 'healthy', sourceSha: manifest.scope.sourceSha, resourceFingerprint: fingerprint(identity), observedAt: new Date().toISOString() };
    } catch (error) { last = error; }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw last;
}
