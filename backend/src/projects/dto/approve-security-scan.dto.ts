import { IsString, MinLength } from "class-validator";

export class ApproveSecurityScanDto {
  @IsString()
  @MinLength(5)
  reason: string;
}
