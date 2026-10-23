import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { PipelineWorkerService } from "./projects/pipeline/pipeline-worker.service";
import { InfrastructureLifecycleWorkerService } from "./infrastructure-lifecycle/infrastructure-lifecycle-worker.service";
import { TtlCleanupSchedulerService } from "./infrastructure-lifecycle/ttl-cleanup-scheduler.service";
import { EmergencyCleanupWorkerService } from "./infrastructure-lifecycle/emergency-cleanup-worker.service";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(PipelineWorkerService);
  worker.start();
  app.get(InfrastructureLifecycleWorkerService).start();
  app.get(TtlCleanupSchedulerService).start();
  app.get(EmergencyCleanupWorkerService).start();
}

bootstrap();
