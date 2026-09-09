import { IsIn } from "class-validator";

export class CreateCheckoutDto {
  @IsIn(["pro", "pro_plus"])
  plan: "pro" | "pro_plus";
}
