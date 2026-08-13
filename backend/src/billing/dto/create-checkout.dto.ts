import { IsIn } from "class-validator";

export class CreateCheckoutDto {
  @IsIn(["pro"])
  plan: "pro";
}
