import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { DeploymentService } from './deployment.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';

@ApiTags('deployments')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('deployments')
export class DeploymentController {
  constructor(private svc: DeploymentService) {}
  @Post()              create(@Body() dto: CreateDeploymentDto, @Req() req: any) { return this.svc.create(dto, req.user); }
  @Get()               findAll(@Req() req: any)                                  { return this.svc.findAll(req.user.id); }
  @Get(':id')          findOne(@Param('id') id: string, @Req() req: any)         { return this.svc.findOne(id, req.user.id); }
  @Get(':id/logs')     getLogs(@Param('id') id: string, @Req() req: any)         { return this.svc.getLogs(id, req.user.id); }
  @Post(':id/rollback')rollback(@Param('id') id: string, @Req() req: any)        { return this.svc.rollback(id, req.user.id); }
  @Delete(':id')       destroy(@Param('id') id: string, @Req() req: any)         { return this.svc.destroy(id, req.user.id); }
}
