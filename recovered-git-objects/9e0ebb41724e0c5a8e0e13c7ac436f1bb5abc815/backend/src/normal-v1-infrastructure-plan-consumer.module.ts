import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm";
import AppDataSource from "./data-source";
import { resolveBackendEnvFile } from "./config/backend-env-file";
import { OrchestrationContractsModule } from "./orchestration-contracts/orchestration-contracts.module";
import { NormalV1InfrastructurePlanConsumerRuntimeService } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-runtime.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: resolveBackendEnvFile() }),
    TypeOrmModule.forRoot({ ...AppDataSource.options, migrations: [], synchronize: false } as TypeOrmModuleOptions),
    OrchestrationContractsModule,
  ],
  providers: [NormalV1InfrastructurePlanConsumerRuntimeService],
  exports: [NormalV1InfrastructurePlanConsumerRuntimeService],
})
export class NormalV1InfrastructurePlanConsumerModule {}
