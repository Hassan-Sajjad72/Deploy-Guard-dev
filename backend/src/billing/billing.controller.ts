import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { BillingService } from "./billing.service";
import { CreateCheckoutDto } from "./dto/create-checkout.dto";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";

@Controller("api/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get("summary") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY])) summary(@Req() req: Request) { return this.billing.summary(req.user!); }
  @Post("checkout") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) checkout(@Req() req: Request, @Body() dto: CreateCheckoutDto) { return this.billing.createCheckout(req.user!, dto.plan, req); }
  @Post("portal") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) portal(@Req() req: Request) { return this.billing.createPortal(req.user!); }
  @Post("webhook/stripe") webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers("stripe-signature") signature = "") { return this.billing.handleStripeWebhook(req.rawBody || Buffer.from(""), signature); }
  @Get("invoices/:invoiceId") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY])) invoice(@Req() req: Request, @Param("invoiceId", ParseUUIDPipe) invoiceId: string) { return this.billing.invoice(req.user!, invoiceId); }
  @Get("invoices/:invoiceId/pdf") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY])) async invoicePdf(@Req() req: Request, @Res() res: Response, @Param("invoiceId", ParseUUIDPipe) invoiceId: string) {
    const pdf = await this.billing.invoicePdf(req.user!, invoiceId);
    res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`); res.setHeader("Cache-Control", "private, no-store"); res.send(pdf.content);
  }
}
