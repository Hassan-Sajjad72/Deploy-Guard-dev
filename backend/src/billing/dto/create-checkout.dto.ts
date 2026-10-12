import { IsIn, IsOptional, IsUUID } from "class-validator";

export class BillingWorkspaceQuery {
  @IsUUID() @IsOptional() organizationId?: string;
}

export class CreateCheckoutDto extends BillingWorkspaceQuery {
  @IsIn(["pro", "pro_plus"])
  plan: "pro" | "pro_plus";
}
