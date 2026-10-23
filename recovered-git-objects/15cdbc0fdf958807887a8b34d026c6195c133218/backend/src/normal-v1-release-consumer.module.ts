import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm";
import AppDataSource from "./data-source";
import { resolveBackendEnvFile } from "./config/backend-env-file";
import {
  OrchestrationContractsModule,
} from "./orchestration-contracts/orchestration-contracts.module";
import {
  NormalV1ReleaseConsumerRuntimeService,
} from "./orchestration-contracts/worker-runtime/normal-v1-release-consumer-runtime.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolveBackendEnvFile(),
    }),
    TypeOrmModule.forRoot({
      ...AppDataSource.options,
      migrations: [],
      synchronize: false,
    } as TypeOrmModuleOptions),
    OrchestrationContractsModule,
  ],
  providers: [NormalV1ReleaseConsumerRuntimeService],
  exports: [NormalV1ReleaseConsumerRuntimeService],
})
export class NormalV1ReleaseConsumerModule {}
