import { IsIn, IsString, Length, Matches } from "class-validator";
import { OrganizationMode } from "./organization.entity";

export class CreateOrganizationDto {
  @IsString() @Length(1, 120) @Matches(/\S/) name: string;
  @IsIn(["TEAM", "AGENCY"]) mode: OrganizationMode = "TEAM";
}

export class RegisterAwsAccountDto {
  @IsString() @Matches(/^\d{12}$/) accountId: string;
  @IsIn(["us-east-1"]) region: string;
  @IsString() @Length(1, 2048)
  @Matches(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/) roleArn: string;
}
