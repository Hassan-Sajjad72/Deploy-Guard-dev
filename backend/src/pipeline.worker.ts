import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { PipelineWorkerService } from "./projects/pipeline/pipeline-worker.service";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(PipelineWorkerService);
  worker.start();
}

bootstrap();
