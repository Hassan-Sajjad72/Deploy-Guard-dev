import { IsDateString, IsIn, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

export class BillingReasonDto {
  @IsString() @Matches(/\S/) @MaxLength(1000) reason: string;
}
export class IssueOrganizationInvoiceDto extends BillingReasonDto {
  @IsUUID() organizationId: string;
  @IsUUID() idempotencyKey: string;
  @IsIn(["pro", "pro_plus"]) plan: "pro" | "pro_plus";
  @IsInt() @Min(1) @Max(2147483647) amountDueCents: number;
  @IsDateString() dueAt: string;
  @IsDateString() periodStart: string;
  @IsDateString() periodEnd: string;
}
export class ReconcileOrganizationInvoiceDto extends BillingReasonDto {
  @IsString() @Matches(/\S/) @MaxLength(200) externalPaymentReference: string;
  @IsInt() @Min(1) @Max(2147483647) amountPaidCents: number;
  @IsDateString() paidAt: string;
}
export class ChangeOrganizationInvoiceDto extends BillingReasonDto {
  @IsIn(["void", "dispute"]) action: "void" | "dispute";
}
export class AdjustOrganizationInvoiceDto extends BillingReasonDto {
  @IsUUID() idempotencyKey: string;
  @IsInt() @Min(1) @Max(2147483647) amountDueCents: number;
}
