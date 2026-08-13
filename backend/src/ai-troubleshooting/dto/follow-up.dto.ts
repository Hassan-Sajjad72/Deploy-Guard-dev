import { IsString, MaxLength, MinLength } from "class-validator";
export class FollowUpDto { @IsString() @MinLength(2) @MaxLength(1000) message: string; }
