import { Body, Controller, Get, Headers, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { BillingService } from "./billing.service";
import { CreateCheckoutDto } from "./dto/create-checkout.dto";
import { IsIn } from "class-validator";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";

class DemoPlanDto { @IsIn(["free", "pro"]) plan: "free" | "pro"; }

@Controller("api/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get("summary") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY])) summary(@Req() req: Request) { return this.billing.summary(req.user!); }
  @Post("checkout") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) checkout(@Req() req: Request, @Body() _dto: CreateCheckoutDto) { return this.billing.createCheckout(req.user!, req); }
  @Post("portal") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) portal(@Req() req: Request) { return this.billing.portal(req.user!); }
  @Post("cancel") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) cancel(@Req() req: Request) { return this.billing.cancel(req.user!, req); }
  @Post("demo/plan") @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER])) demoPlan(@Req() req: Request, @Body() dto: DemoPlanDto) { return this.billing.setDemoPlan(req.user!, dto.plan, req); }
  @Post("webhook/stripe") webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers("stripe-signature") signature = "") { return this.billing.handleStripeWebhook(req.rawBody || Buffer.from(""), signature); }
}
