import { IsString, Matches } from "class-validator";

export class UpdateBranchDto {
  @IsString()
  @Matches(/\S/, { message: "targetBranch is required" })
  targetBranch: string;
}
