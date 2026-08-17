import { IsUUID } from "class-validator";

export class RollbackGithubActionsDto {
  @IsUUID()
  targetOperationId: string;
}
