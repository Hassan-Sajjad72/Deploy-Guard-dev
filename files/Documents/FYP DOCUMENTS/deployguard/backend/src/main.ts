import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api/v1');
  const config = new DocumentBuilder()
    .setTitle('DeployGuard API').setDescription('Cloud-Native Deployment API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`DeployGuard API: http://localhost:${port}`);
  console.log(`Swagger docs:    http://localhost:${port}/api/docs`);
}
bootstrap();
