import { Equals, IsString, MaxLength, MinLength } from "class-validator";
import { DESTROY_CONFIRMATION_PHRASE } from "../destroy-confirmation";

/** Request contract for the project-scoped Railpack Destroy endpoint. */
export class DestroyGithubActionsDto {
  @IsString()
  @Equals(DESTROY_CONFIRMATION_PHRASE)
  @MinLength(DESTROY_CONFIRMATION_PHRASE.length)
  @MaxLength(DESTROY_CONFIRMATION_PHRASE.length)
  confirmationPhrase: string;
}
