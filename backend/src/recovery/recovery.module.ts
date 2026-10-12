import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { PlanningModule } from "../planning/planning.module";
import { UsersModule } from "../users/users.module";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { RecoveryController } from "./recovery.controller";
import { RecoveryService } from "./recovery.service";
import { RepairService } from "./repair.service";
@Module({ imports: [ProjectsModule, PlanningModule, UsersModule, AuditLogModule], controllers: [RecoveryController], providers: [RecoveryService, RepairService] })
export class RecoveryModule {}
