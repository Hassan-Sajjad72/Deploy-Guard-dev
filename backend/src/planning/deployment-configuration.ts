import { canonicalEnvironmentName } from "../projects/canonical-environment";
import { Project } from "../projects/project.entity";
import { ProjectDeployableService } from "../projects/project-deployable-service.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { planFingerprint } from "./deployment-plan";

export function deploymentConfigurationFingerprint(project: Project, services: ProjectDeployableService[], variables: ProjectEnvironmentVariable[], database: ProjectDatabaseTier | null, binding: AwsAccountBinding) {
  return planFingerprint({ project: { organizationId: project.organizationId, clientId: project.clientId || null, engagementId: project.engagementId || null, repositoryUrl: project.repositoryUrl,
    repositoryFullName: project.repositoryFullName, installationId: project.githubInstallationId, branch: project.targetBranch,
    entrypoint: project.applicationEntryPointServiceId, environment: canonicalEnvironmentName(project), bindingId: project.awsAccountBindingId, executionMode: project.executionMode },
    services: services.map(({ id, name, serviceDirectory, buildTargetOverride, position }) => ({ id, name, serviceDirectory, buildTargetOverride, position })),
    variables: variables.map(({ id, serviceId, key, value, scope, isSecret }) => ({ id, serviceId, key, value, scope, isSecret })),
    database: database ? { provider: database.provider, engine: database.engine, attachedServiceId: database.attachedServiceId,
      persistence: database.persistenceEnabled, backup: database.backupEnabled, host: database.externalHost, port: database.externalPort, tls: database.externalTlsRequired } : null,
    binding: { id: binding.id, accountId: binding.accountId, roleArn: binding.roleArn, regions: binding.regions,
      status: binding.verificationStatus, version: binding.verificationVersion, evidence: binding.verificationEvidence } });
}
