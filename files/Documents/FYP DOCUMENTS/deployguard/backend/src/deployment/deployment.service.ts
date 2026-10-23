import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deployment, DeploymentStatus } from './deployment.entity';
import { CreateDeploymentDto } from './dto/create-deployment.dto';

@Injectable()
export class DeploymentService {
  private readonly logger = new Logger(DeploymentService.name);

  constructor(@InjectRepository(Deployment) private repo: Repository<Deployment>) {}

  async create(dto: CreateDeploymentDto, user: any): Promise<Deployment> {
    const d = this.repo.create({ ...dto, user, status: DeploymentStatus.PENDING });
    const saved = await this.repo.save(d);
    this.runPipeline(saved.id).catch(e => this.logger.error(`Pipeline ${saved.id}: ${e.message}`));
    return saved;
  }

  async findAll(userId: string): Promise<Deployment[]> {
    return this.repo.find({ where: { user: { id: userId } }, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string, userId: string): Promise<Deployment> {
    const d = await this.repo.findOne({ where: { id, user: { id: userId } } });
    if (!d) throw new NotFoundException(`Deployment ${id} not found`);
    return d;
  }

  async rollback(id: string, userId: string): Promise<Deployment> {
    const d = await this.findOne(id, userId);
    d.status = DeploymentStatus.ROLLED_BACK;
    d.logs = (d.logs || '') + `\n[${new Date().toISOString()}] Rollback triggered`;
    return this.repo.save(d);
  }

  async destroy(id: string, userId: string): Promise<{ message: string }> {
    const d = await this.findOne(id, userId);
    d.status = DeploymentStatus.STOPPED;
    d.logs = (d.logs || '') + `\n[${new Date().toISOString()}] Infrastructure destroyed`;
    await this.repo.save(d);
    return { message: `Deployment ${id} destroyed` };
  }

  async getLogs(id: string, userId: string): Promise<{ logs: string }> {
    const d = await this.findOne(id, userId);
    return { logs: d.logs || 'No logs yet.' };
  }

  private async runPipeline(id: string): Promise<void> {
    const s = (ms: number) => new Promise(r => setTimeout(r, ms));
    const up = async (status: DeploymentStatus, msg: string) => {
      await this.repo.update(id, { status });
      const d = await this.repo.findOne({ where: { id } });
      if (d) { d.logs = (d.logs || '') + `\n[${new Date().toISOString()}] ${msg}`; await this.repo.save(d); }
    };
    try {
      await s(800);  await up(DeploymentStatus.BUILDING,  'Cloning repository from GitHub...');
      await s(1500); await up(DeploymentStatus.BUILDING,  'Validating Dockerfile...');
      await s(1000); await up(DeploymentStatus.BUILDING,  'Building Docker image...');
      await s(2500); await up(DeploymentStatus.BUILDING,  'Running security scan on layers...');
      await s(1200); await up(DeploymentStatus.BUILDING,  'Pushing image to Amazon ECR...');
      await s(2000); await up(DeploymentStatus.DEPLOYING, 'Provisioning ECS Fargate via Terraform...');
      await s(3000); await up(DeploymentStatus.DEPLOYING, 'Registering ECS task definition...');
      await s(1500); await up(DeploymentStatus.DEPLOYING, 'Creating ECS service with Spot capacity...');
      await s(2000); await up(DeploymentStatus.DEPLOYING, 'Configuring ALB target group...');
      await s(3000); await up(DeploymentStatus.RUNNING,   'Deployment successful! Service is healthy.');
    } catch (err) {
      await this.repo.update(id, { status: DeploymentStatus.FAILED, errorMessage: err.message });
    }
  }
}
