import { IsString, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DeploymentMode } from '../deployment.entity';

export class CreateDeploymentDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() repositoryUrl: string;
  @ApiProperty({ required: false }) @IsString() @IsOptional() branch?: string;
  @ApiProperty({ required: false }) @IsString() @IsOptional() dockerfilePath?: string;
  @ApiProperty({ enum: DeploymentMode }) @IsEnum(DeploymentMode) mode: DeploymentMode;
  @ApiProperty({ required: false }) @IsOptional() config?: Record<string, any>;
}
