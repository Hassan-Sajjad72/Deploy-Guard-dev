import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { TROUBLESHOOTING_QUESTIONS, TroubleshootingQuestionType } from "../ai-troubleshooting-contract";
export class FollowUpDto {
  @IsString() @MinLength(2) @MaxLength(1000) message: string;
  @IsOptional() @IsIn(TROUBLESHOOTING_QUESTIONS.map((question) => question.type)) questionType?: TroubleshootingQuestionType;
}
