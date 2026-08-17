import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CentralCloudResource } from "../infrastructure-lifecycle/central-cloud-resource.entity";
import { ProjectResourceRegistryService } from "./project-resource-registry.service";

@Module({
  imports: [TypeOrmModule.forFeature([CentralCloudResource])],
  providers: [ProjectResourceRegistryService],
  exports: [ProjectResourceRegistryService],
})
export class ResourceRegistryModule {}
