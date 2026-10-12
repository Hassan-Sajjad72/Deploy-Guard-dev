import { Equals, IsIn, IsInt, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from "class-validator";

export class CreateWorkspaceDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsIn(["team", "agency"]) kind: "team" | "agency";
}

export class SetMembershipDto {
  @IsInt() @Min(1) userId: number;
  @IsIn(["admin", "engineer", "approver", "viewer"]) role: "admin" | "engineer" | "approver" | "viewer";
}

export class AgencyRecordNameDto {
  @IsString() @Matches(/\S/) @MaxLength(120) name: string;
}

export class CreateEngagementDto extends AgencyRecordNameDto {
  @IsUUID() awsAccountBindingId: string;
  @Equals(true) clientAuthorizationConfirmed: true;
  @IsString() @Matches(/\S/) @MaxLength(1000) authorizationReference: string;
}

export class ArchiveAgencyRecordDto {
  @IsString() @Matches(/\S/) @MaxLength(1000) reason: string;
}
