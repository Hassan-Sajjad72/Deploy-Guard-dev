import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { TerraformExportArtifact } from "./terraform-export-artifact.entity";
import { TerraformExportController } from "./terraform-export.controller";
import { TerraformExportService } from "./terraform-export.service";
import { ProjectsModule } from "../projects/projects.module";
import { OperationalEvidenceController } from "./operational-evidence.controller";
@Module({ imports: [TypeOrmModule.forFeature([Project, ProjectInfrastructureEnvironment, TerraformExportArtifact]), AuditLogModule, ProjectsModule], controllers: [TerraformExportController, OperationalEvidenceController], providers: [TerraformExportService], exports: [TerraformExportService] })
export class TerraformExportModule {}
