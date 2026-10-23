import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { BillingModule } from "../billing/billing.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { TerraformExportArtifact } from "./terraform-export-artifact.entity";
import { TerraformExportController } from "./terraform-export.controller";
import { TerraformExportService } from "./terraform-export.service";
@Module({ imports: [TypeOrmModule.forFeature([Project, ProjectInfrastructureEnvironment, TerraformExportArtifact]), AuditLogModule, BillingModule], controllers: [TerraformExportController], providers: [TerraformExportService], exports: [TerraformExportService] })
export class TerraformExportModule {}
