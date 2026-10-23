import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeploymentController } from './deployment.controller';
import { DeploymentService } from './deployment.service';
import { Deployment } from './deployment.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Deployment])],
  controllers: [DeploymentController],
  providers: [DeploymentService],
})
export class DeploymentModule {}
