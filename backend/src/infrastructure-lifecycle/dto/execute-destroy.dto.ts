import { Equals, IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";
export class ExecuteDestroyDto {
  @IsUUID() challengeId: string;
  @IsString() @MinLength(16) @MaxLength(256) challengeToken: string;
  @IsString() @Equals("DESTROY") @MinLength(3) @MaxLength(200) confirmationPhrase: string;
  @IsString() @MinLength(1) @MaxLength(50) environmentName: string;
  @IsOptional() @IsBoolean() deletePersistentDatabaseData?: boolean;
  @ValidateIf((value) => value.deletePersistentDatabaseData === true)
  @IsString() @Equals("DELETE PERSISTENT DATABASE DATA")
  databaseDataConfirmation?: string;
}
