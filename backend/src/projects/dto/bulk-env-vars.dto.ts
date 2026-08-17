import { ArrayMaxSize, ArrayMinSize, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CreateEnvVarDto } from "./create-env-var.dto";

export class BulkEnvVarsDto {
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateEnvVarDto)
  variables: CreateEnvVarDto[];
}
