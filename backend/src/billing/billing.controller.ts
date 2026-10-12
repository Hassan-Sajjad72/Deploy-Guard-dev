import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { BillingService } from "./billing.service";
import { BillingWorkspaceQuery, CreateCheckoutDto } from "./dto/create-checkout.dto";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";

@Controller("api/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get("summary") @UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY])) async summary(@Req() req: Request, @Query() query: BillingWorkspaceQuery) { return this.billing.summary(req.user!, await this.billing.workspaceScope(req.user!, query.organizationId)); }
  @Post("checkout") @UseGuards(requireRole([UserRole.DEVELOPER])) async checkout(@Req() req: Request, @Body() dto: CreateCheckoutDto) { return this.billing.createCheckout(req.user!, dto.plan, req, await this.billing.workspaceScope(req.user!, dto.organizationId)); }
  @Post("portal") @UseGuards(requireRole([UserRole.DEVELOPER])) async portal(@Req() req: Request, @Body() dto: BillingWorkspaceQuery) { return this.billing.createPortal(req.user!, await this.billing.workspaceScope(req.user!, dto.organizationId)); }
  @Post("webhook/stripe") webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers("stripe-signature") signature = "") { return this.billing.handleStripeWebhook(req.rawBody || Buffer.from(""), signature); }
  @Get("invoices/:invoiceId") @UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY])) async invoice(@Req() req: Request, @Param("invoiceId", ParseUUIDPipe) invoiceId: string, @Query() query: BillingWorkspaceQuery) { return this.billing.invoice(req.user!, invoiceId, await this.billing.workspaceScope(req.user!, query.organizationId)); }
  @Get("invoices/:invoiceId/pdf") @UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY])) async invoicePdf(@Req() req: Request, @Res() res: Response, @Param("invoiceId", ParseUUIDPipe) invoiceId: string, @Query() query: BillingWorkspaceQuery) {
    const pdf = await this.billing.invoicePdf(req.user!, invoiceId, await this.billing.workspaceScope(req.user!, query.organizationId));
    res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`); res.setHeader("Cache-Control", "private, no-store"); res.send(pdf.content);
  }
}
