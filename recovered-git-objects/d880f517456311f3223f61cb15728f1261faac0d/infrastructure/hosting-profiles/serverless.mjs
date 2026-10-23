import { addResource, baseTerraform, boundedNumber, environmentReferences, exactKeys, finish, fingerprint, item, json, literal, ownershipTags, reference, requireValue, resourceName, secretReferences, sha, text, uuid, validateScope } from './contracts.mjs';

function safeAsset(path) {
  text(path, /^[A-Za-z0-9][A-Za-z0-9_./-]{0,239}$/, 'artifact path');
  requireValue(!path.split('/').some((v) => !v || v === '.' || v === '..' || v.startsWith('.')) && !/(^|\/)(?:node_modules|\.git|\.env)(\/|$)/i.test(path), 'Unsafe artifact path.');
  return path;
}
function privateBucket(tf, name, tags, scope) {
  addResource(tf, 'aws_s3_bucket', 'artifacts', { bucket: name, force_destroy: false, tags });
  addResource(tf, 'aws_s3_bucket_public_access_block', 'artifacts', { bucket: reference('aws_s3_bucket.artifacts.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true });
  addResource(tf, 'aws_s3_bucket_ownership_controls', 'artifacts', { bucket: reference('aws_s3_bucket.artifacts.id'), rule: { object_ownership: 'BucketOwnerEnforced' } });
  addResource(tf, 'aws_s3_bucket_versioning', 'artifacts', { bucket: reference('aws_s3_bucket.artifacts.id'), expected_bucket_owner: scope.accountId, versioning_configuration: { status: 'Enabled' } });
  addResource(tf, 'aws_s3_bucket_server_side_encryption_configuration', 'artifacts', { bucket: reference('aws_s3_bucket.artifacts.id'), expected_bucket_owner: scope.accountId, rule: { apply_server_side_encryption_by_default: { sse_algorithm: 'AES256' } } });
}
function buildEvidence(config, scope, kind) {
  exactKeys(config.build, ['sourceSha', 'kind', 'fingerprint', 'securityScanFingerprint', 'status'], 'build evidence');
  requireValue(config.build.sourceSha === scope.sourceSha && config.build.kind === kind && config.build.status === 'verified', 'The source-pinned build compatibility evidence is missing.');
  sha(config.build.fingerprint, 'build fingerprint'); sha(config.build.securityScanFingerprint, 'build security scan fingerprint');
}
export function buildStatic(input) {
  const s = validateScope(input, 'static'), c = input.configuration, tf = baseTerraform(s), name = resourceName(s), tags = ownershipTags(s);
  exactKeys(c, ['build', 'assets', 'spa', 'priceClass', 'healthPath'], 'static profile configuration'); buildEvidence(c, s, 'static');
  requireValue(input.plan.assumptions?.stateful === false && input.plan.assumptions?.continuousCompute === false && !input.plan.dependencies?.database && input.plan.environmentReferences?.length === 0, 'Static hosting cannot retain server runtime, database or environment dependencies.');
  requireValue(input.plan.services?.length === 1 && input.plan.services[0].buildTarget?.status === 'resolved' && input.plan.services[0].buildTarget.sourceSha === s.sourceSha, 'Static hosting requires one exact-SHA verified static target.');
  requireValue(typeof c.spa === 'boolean' && ['PriceClass_100', 'PriceClass_200', 'PriceClass_All'].includes(c.priceClass), 'CDN behavior must be explicitly approved.');
  requireValue(Array.isArray(c.assets) && c.assets.length >= 1 && c.assets.length <= 1000, 'The static asset manifest must contain 1–1000 files.');
  const paths = new Set(); let bytes = 0;
  for (const a of c.assets) {
    exactKeys(a, ['path', 'sha256', 'bytes', 'contentType'], 'static asset'); safeAsset(a.path); sha(a.sha256, 'asset SHA');
    requireValue(!paths.has(a.path), 'Duplicate asset path.'); paths.add(a.path);
    boundedNumber(a.bytes, 0, 50 * 1024 * 1024, 'asset bytes', true); bytes += a.bytes;
    text(a.contentType, /^(?:text\/(?:html|css|plain)|application\/(?:javascript|json|wasm|manifest\+json)|image\/(?:png|jpeg|gif|svg\+xml|webp|x-icon|avif)|font\/(?:woff2?|ttf|otf))$/, 'asset content type');
  }
  requireValue(bytes <= 200 * 1024 * 1024 && paths.has('index.html'), 'Static artifacts require a bounded index.html build.');
  text(c.healthPath, /^\/[A-Za-z0-9_./-]*$/, 'static health path');
  requireValue(c.healthPath === '/' || paths.has(c.healthPath.slice(1)), 'Static health must check a declared artifact.');
  const bucketName = `${name}-${s.accountId}`;
  privateBucket(tf, bucketName, tags, s);
  const prefix = `generations/${s.generationId}/`;
  c.assets.forEach((a, i) => addResource(tf, 'aws_s3_object', `asset_${i}`, { bucket: reference('aws_s3_bucket.artifacts.id'), key: prefix + a.path, source: literal('assets/' + a.path), source_hash: a.sha256, checksum_algorithm: 'SHA256', metadata: { 'dg-sha256': a.sha256, 'source-sha': s.sourceSha }, content_type: a.contentType, cache_control: a.path === 'index.html' ? 'no-cache' : 'public,max-age=31536000,immutable', server_side_encryption: 'AES256', tags,
    depends_on: ['aws_s3_bucket_versioning.artifacts', 'aws_s3_bucket_public_access_block.artifacts', 'aws_s3_bucket_server_side_encryption_configuration.artifacts'] }));
  addResource(tf, 'aws_cloudfront_origin_access_control', 'artifacts', { name, description: `Private static generation ${s.generationId}`, origin_access_control_origin_type: 's3', signing_behavior: 'always', signing_protocol: 'sigv4' });
  const distribution = { enabled: true, is_ipv6_enabled: true, default_root_object: 'index.html', price_class: c.priceClass, wait_for_deployment: true, tags,
    origin: [{ domain_name: reference('aws_s3_bucket.artifacts.bucket_regional_domain_name'), origin_id: 'private-generation', origin_path: '/' + prefix.slice(0, -1), origin_access_control_id: reference('aws_cloudfront_origin_access_control.artifacts.id') }],
    default_cache_behavior: { allowed_methods: ['GET', 'HEAD'], cached_methods: ['GET', 'HEAD'], target_origin_id: 'private-generation', viewer_protocol_policy: 'redirect-to-https', compress: true, min_ttl: 0, default_ttl: 60, max_ttl: 31536000, forwarded_values: { query_string: false, cookies: { forward: 'none' } } },
    restrictions: { geo_restriction: { restriction_type: 'none' } }, viewer_certificate: { cloudfront_default_certificate: true },
    depends_on: c.assets.map((_, i) => `aws_s3_object.asset_${i}`),
  };
  if (c.spa) distribution.custom_error_response = [403, 404].map((code) => ({ error_code: code, response_code: 200, response_page_path: '/index.html', error_caching_min_ttl: 0 }));
  addResource(tf, 'aws_cloudfront_distribution', 'runtime', distribution);
  addResource(tf, 'aws_s3_bucket_policy', 'artifacts', { bucket: reference('aws_s3_bucket.artifacts.id'), policy: JSON.stringify({ Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: reference('aws_s3_bucket.artifacts.arn') + '/' + prefix + '*', Condition: { StringEquals: { 'AWS:SourceArn': reference('aws_cloudfront_distribution.runtime.arn') } } },
    { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [reference('aws_s3_bucket.artifacts.arn'), reference('aws_s3_bucket.artifacts.arn') + '/*'], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  ] }), depends_on: ['aws_s3_bucket_public_access_block.artifacts'] });
  tf.output.runtime_identity = { value: { distributionId: reference('aws_cloudfront_distribution.runtime.id'), distributionArn: reference('aws_cloudfront_distribution.runtime.arn'), bucket: bucketName, objectPrefix: prefix, endpoint: reference('"https://${aws_cloudfront_distribution.runtime.domain_name}"'), sourceSha: s.sourceSha, generationId: s.generationId, buildFingerprint: c.build.fingerprint } };
  return finish(input, s, tf, { 'assets-manifest.json': JSON.stringify({ sourceSha: s.sourceSha, buildFingerprint: c.build.fingerprint, files: c.assets }, null, 2) + '\n' }, [item('compute', 'AmazonS3', 'no persistent application compute; priced storage/CDN', 0, 'instance-hours'), item('storage', 'AmazonS3', 'versioned generation objects', bytes / 1024 ** 3, 'GiB-month'), item('network', 'AmazonCloudFront', c.priceClass, 1, 'distribution'), item('requests', 'AmazonCloudFront', 'HTTPS and S3 origin requests', input.plan.assumptions.monthlyRequests, 'requests', 'variable'), item('data_transfer', 'AmazonCloudFront', 'edge Internet egress', input.plan.assumptions.monthlyTransferGiB, 'GiB', 'variable'), item('monitoring', 'AmazonCloudWatch', 'CDN metrics and alarms', 1, 'generation', 'variable')],
    { kind: 'verified_static', serverRuntime: false, tls: 'cloudfront', healthPath: c.healthPath, files: c.assets.length, bytes, limitations: ['No API process, runtime environment injection or database attachment.', 'Prior generations and object versions incur storage until approved retention cleanup.'] }, tf.output.runtime_identity.value);
}

export function buildLambda(input) {
  const s = validateScope(input, 'lambda'), c = input.configuration, tf = baseTerraform(s), name = resourceName(s), tags = ownershipTags(s);
  exactKeys(c, ['build', 'serviceId', 'architecture', 'runtime', 'handler', 'artifact', 'adapter', 'publicEnvironment', 'secretReferences', 'timeoutSeconds', 'memoryMiB', 'ephemeralStorageMiB', 'reservedConcurrency', 'requestsPerSecond', 'burstLimit', 'healthPath', 'authorization'], 'Lambda configuration');
  buildEvidence(c, s, 'lambda_http'); uuid(c.serviceId, 'Lambda service');
  requireValue(input.plan.services?.length === 1 && input.plan.services[0].id === c.serviceId && input.plan.services[0].buildTarget?.status === 'resolved' && input.plan.services[0].buildTarget.sourceSha === s.sourceSha, 'Lambda requires a single verified exact-SHA service.');
  requireValue(input.plan.assumptions.stateful === false && input.plan.assumptions.continuousCompute === false && !input.plan.dependencies?.database, 'This Lambda HTTP adapter does not provision or migrate stateful databases.');
  requireValue(['amd64', 'arm64'].includes(c.architecture) && (input.plan.services[0].buildTarget.architecture || input.plan.services[0].buildTarget.evidence?.architecture || c.architecture) === c.architecture, 'Lambda architecture differs from the resolved build.');
  requireValue(['nodejs22.x', 'python3.12', 'provided.al2023'].includes(c.runtime), 'A currently supported and explicitly verified Lambda runtime is required.');
  text(c.handler, /^[A-Za-z0-9_/.-]{1,100}\.[A-Za-z0-9_]{1,100}$/, 'native Lambda handler'); requireValue(!c.handler.includes('..'), 'Unsafe handler path.');
  exactKeys(c.adapter, ['kind', 'fingerprint', 'payloadFormat', 'timeoutBounded', 'filesystemEphemeral', 'backgroundWorkers', 'maximumRequestBytes', 'maximumResponseBytes'], 'Lambda adapter evidence');
  requireValue(c.adapter.kind === 'native_http' && c.adapter.payloadFormat === '2.0' && c.adapter.timeoutBounded === true && c.adapter.filesystemEphemeral === true && c.adapter.backgroundWorkers === false, 'A verified HTTP API payload-v2 native handler with no background workers is required.');
  sha(c.adapter.fingerprint, 'adapter fingerprint'); boundedNumber(c.adapter.maximumRequestBytes, 1, 6 * 1024 * 1024, 'request size', true); boundedNumber(c.adapter.maximumResponseBytes, 1, 6 * 1024 * 1024, 'response size', true);
  const env = environmentReferences(c.publicEnvironment), secrets = secretReferences(c.secretReferences, s);
  requireValue(secrets.length === 0, 'Lambda secret resolution must be implemented and verified in its build adapter before secret-bearing plans are admitted.');
  boundedNumber(c.timeoutSeconds, 1, 29, 'HTTP integration timeout', true); boundedNumber(c.memoryMiB, 128, 10240, 'Lambda memory', true); boundedNumber(c.ephemeralStorageMiB, 512, 10240, 'ephemeral storage', true); boundedNumber(c.reservedConcurrency, 1, 1000, 'reserved concurrency', true);
  boundedNumber(c.requestsPerSecond, 1, 10000, 'HTTP throttle rate'); boundedNumber(c.burstLimit, 1, 5000, 'HTTP burst limit', true);
  requireValue(c.authorization === 'public_application_endpoint', 'Public HTTP exposure must be explicit in the approved plan.');
  text(c.healthPath, /^\/(?:[A-Za-z0-9_~-]+\/?)*$/, 'Lambda health path');
  exactKeys(c.artifact, ['sha256', 'bytes', 'uncompressedBytes'], 'Lambda ZIP artifact'); sha(c.artifact.sha256, 'ZIP SHA'); boundedNumber(c.artifact.bytes, 1, 50 * 1024 * 1024, 'ZIP size', true); boundedNumber(c.artifact.uncompressedBytes, c.artifact.bytes, 250 * 1024 * 1024, 'uncompressed ZIP size', true);
  const bucketName = `${name}-${s.accountId}`, prefix = `generations/${s.generationId}/`;
  privateBucket(tf, bucketName, tags, s);
  addResource(tf, 'aws_s3_object', 'code', { bucket: reference('aws_s3_bucket.artifacts.id'), key: prefix + 'function.zip', source: 'assets/function.zip', source_hash: c.artifact.sha256, content_type: 'application/zip', server_side_encryption: 'AES256', tags, depends_on: ['aws_s3_bucket_versioning.artifacts', 'aws_s3_bucket_public_access_block.artifacts'] });
  addResource(tf, 'aws_cloudwatch_log_group', 'runtime', { name: '/aws/lambda/' + name, retention_in_days: 30, tags });
  addResource(tf, 'aws_cloudwatch_log_group', 'http', { name: '/deployguard/http/' + name, retention_in_days: 30, tags });
  addResource(tf, 'aws_iam_role', 'runtime', { name, assume_role_policy: json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }), tags });
  addResource(tf, 'aws_iam_role_policy', 'runtime', { name, role: reference('aws_iam_role.runtime.id'), policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: reference('aws_cloudwatch_log_group.runtime.arn') + ':*' }] }) });
  addResource(tf, 'aws_lambda_function', 'runtime', { function_name: name, role: reference('aws_iam_role.runtime.arn'), runtime: c.runtime, handler: c.handler, architectures: [c.architecture === 'amd64' ? 'x86_64' : 'arm64'], s3_bucket: reference('aws_s3_bucket.artifacts.id'), s3_key: reference('aws_s3_object.code.key'), s3_object_version: reference('aws_s3_object.code.version_id'), source_code_hash: Buffer.from(c.artifact.sha256, 'hex').toString('base64'), publish: true, timeout: c.timeoutSeconds, memory_size: c.memoryMiB, ephemeral_storage: { size: c.ephemeralStorageMiB }, reserved_concurrent_executions: c.reservedConcurrency, environment: { variables: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, literal(value)])) }, tags, depends_on: ['aws_cloudwatch_log_group.runtime', 'aws_iam_role_policy.runtime'] });
  addResource(tf, 'aws_lambda_alias', 'candidate', { name: 'candidate', function_name: reference('aws_lambda_function.runtime.function_name'), function_version: reference('aws_lambda_function.runtime.version') });
  addResource(tf, 'aws_apigatewayv2_api', 'http', { name, protocol_type: 'HTTP', tags });
  addResource(tf, 'aws_apigatewayv2_integration', 'http', { api_id: reference('aws_apigatewayv2_api.http.id'), integration_type: 'AWS_PROXY', integration_uri: reference('aws_lambda_alias.candidate.invoke_arn'), payload_format_version: '2.0', timeout_milliseconds: c.timeoutSeconds * 1000 });
  addResource(tf, 'aws_apigatewayv2_route', 'http', { api_id: reference('aws_apigatewayv2_api.http.id'), route_key: '$default', authorization_type: 'NONE', target: reference('"integrations/${aws_apigatewayv2_integration.http.id}"') });
  addResource(tf, 'aws_apigatewayv2_stage', 'http', { api_id: reference('aws_apigatewayv2_api.http.id'), name: '$default', auto_deploy: true, default_route_settings: { throttling_burst_limit: c.burstLimit, throttling_rate_limit: c.requestsPerSecond }, access_log_settings: { destination_arn: reference('aws_cloudwatch_log_group.http.arn'), format: json({ requestId: '$context.requestId', status: '$context.status', integrationError: '$context.integrationErrorMessage', responseLength: '$context.responseLength' }) }, tags });
  addResource(tf, 'aws_lambda_permission', 'http', { statement_id: 'ApprovedHttpGatewayOnly', action: 'lambda:InvokeFunction', function_name: reference('aws_lambda_function.runtime.function_name'), qualifier: reference('aws_lambda_alias.candidate.name'), principal: 'apigateway.amazonaws.com', source_account: s.accountId, source_arn: reference('aws_apigatewayv2_api.http.execution_arn') + '/*/*' });
  tf.output.runtime_identity = { value: { functionArn: reference('aws_lambda_function.runtime.arn'), version: reference('aws_lambda_function.runtime.version'), aliasArn: reference('aws_lambda_alias.candidate.arn'), apiId: reference('aws_apigatewayv2_api.http.id'), endpoint: reference('aws_apigatewayv2_api.http.api_endpoint'), bucket: bucketName, objectPrefix: prefix, sourceSha: s.sourceSha, generationId: s.generationId, artifactSha256: c.artifact.sha256, adapterFingerprint: c.adapter.fingerprint } };
  return finish(input, s, tf, { 'lambda-artifact-manifest.json': JSON.stringify({ sourceSha: s.sourceSha, path: 'function.zip', ...c.artifact, adapter: c.adapter, runtime: c.runtime, architecture: c.architecture }, null, 2) + '\n' }, [item('compute', 'AWSLambda', 'duration and architecture', input.plan.assumptions.monthlyRequests, 'invocations', 'variable'), item('storage', 'AmazonS3', 'ZIP artifact versions and Lambda ephemeral storage', c.artifact.bytes / 1024 ** 3, 'GiB-month'), item('network', 'AmazonApiGateway', 'HTTP integration', 1, 'API'), item('requests', 'AmazonApiGateway', 'HTTP API and Lambda requests', input.plan.assumptions.monthlyRequests, 'requests', 'variable'), item('data_transfer', 'AWSLambda', 'Internet response egress', input.plan.assumptions.monthlyTransferGiB, 'GiB', 'variable'), item('monitoring', 'AmazonCloudWatch', 'function and HTTP access logs', input.plan.assumptions.monthlyLogGiB, 'GiB', 'variable')],
    { kind: 'native_lambda_http', architecture: c.architecture, runtime: c.runtime, invocationTimeoutSeconds: c.timeoutSeconds, integration: 'http_api_payload_v2', tls: 'api_gateway', healthPath: c.healthPath, limitations: ['Native stateless HTTP handler only; event triggers and arbitrary server processes are unsupported.', 'No private database, VPC attachment or secret bootstrap is assumed.', 'Cold starts, concurrency quotas and duration pricing require workload evidence.'] }, tf.output.runtime_identity.value);
}
