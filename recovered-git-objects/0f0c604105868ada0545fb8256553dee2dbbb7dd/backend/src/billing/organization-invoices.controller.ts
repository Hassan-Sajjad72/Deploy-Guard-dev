import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { BillingReasonDto, ChangeOrganizationInvoiceDto, IssueOrganizationInvoiceDto, ReconcileOrganizationInvoiceDto } from "./dto/organization-invoice.dto";
import { OrganizationInvoicesService } from "./organization-invoices.service";

@Controller("api/admin/billing")
@UseGuards(requireRole([UserRole.ADMIN]))
export class OrganizationInvoicesController {
  constructor(private readonly invoices: OrganizationInvoicesService) {}
  @Get(":organizationId/invoices") async list(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string) { return { invoices: await this.invoices.list(req.user!, organizationId) }; }
  @Post("invoices") issue(@Req() req: Request, @Body() dto: IssueOrganizationInvoiceDto) { return this.invoices.issue(req.user!, dto); }
  @Post(":organizationId/invoices/:id/reconcile") reconcile(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReconcileOrganizationInvoiceDto) { return this.invoices.reconcile(req.user!, organizationId, id, dto); }
  @Post(":organizationId/invoices/:id/status") change(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ChangeOrganizationInvoiceDto) { return this.invoices.changeInvoice(req.user!, organizationId, id, dto); }
  @Post(":organizationId/subscription/cancel") cancel(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string, @Body() dto: BillingReasonDto) { return this.invoices.cancel(req.user!, organizationId, dto.reason); }
}
