import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectServiceDiscoveryRecord } from "./project-service-discovery-record.entity";

@Injectable()
export class ServiceDiscoveryService {
  constructor(
    @InjectRepository(ProjectServiceDiscoveryRecord)
    private readonly recordRepository: Repository<ProjectServiceDiscoveryRecord>
  ) {}

  mapCloudMapOutputs(outputs: Record<string, unknown>) {
    return {
      namespaceId: String(outputs.cloud_map_namespace_id || ""),
      namespaceName: String(outputs.cloud_map_namespace_name || ""),
      dnsName: String(outputs.cloud_map_service_discovery_domain || ""),
      cloudMapServiceId: outputs.default_cloud_map_service_id
        ? String(outputs.default_cloud_map_service_id)
        : null,
    };
  }

  buildInternalDnsName(serviceName: string, namespaceName: string) {
    return `${serviceName}.${namespaceName}`;
  }

  async saveServiceDiscoveryRecord(
    projectId: string,
    infrastructureEnvironmentId: string,
    serviceName: string,
    outputs: Record<string, unknown>
  ) {
    const mapped = this.mapCloudMapOutputs(outputs);

    if (!mapped.namespaceId || !mapped.namespaceName) {
      return null;
    }

    const existing = await this.recordRepository.findOne({
      where: { projectId, infrastructureEnvironmentId, serviceName },
    });
    const record = existing || this.recordRepository.create({ projectId, infrastructureEnvironmentId, serviceName });

    record.namespaceId = mapped.namespaceId;
    record.namespaceName = mapped.namespaceName;
    record.cloudMapServiceId = mapped.cloudMapServiceId;
    record.dnsName = this.buildInternalDnsName(serviceName, mapped.namespaceName);
    record.status = "ready";
    record.metadata = { cloudMapDomain: mapped.dnsName };

    return this.recordRepository.save(record);
  }
}
