import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, Matches } from "class-validator";

export class CreateAwsAccountBindingDto {
  @Matches(/^\d{12}$/) accountId: string;
  @Matches(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/) roleArn: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique()
  @IsString({ each: true }) @Matches(/^[a-z]{2}-[a-z]+-\d$/, { each: true }) regions: string[];
}
