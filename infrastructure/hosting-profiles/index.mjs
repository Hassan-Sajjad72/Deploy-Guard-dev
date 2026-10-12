export { buildEc2, buildLightsail } from './compute.mjs';
export { buildStatic, buildLambda } from './serverless.mjs';
export { fingerprint, CONTRACT_VERSION, AWS_PROVIDER_VERSION } from './contracts.mjs';
import { buildEc2, buildLightsail } from './compute.mjs';
import { buildStatic, buildLambda } from './serverless.mjs';
const builders = { ec2: buildEc2, lightsail: buildLightsail, static: buildStatic, lambda: buildLambda };
export function buildHostingArtifacts(input) {
  const build = builders[input?.profile]; if (!build) throw new Error('Unsupported hosting artifact profile.');
  return build(input);
}
