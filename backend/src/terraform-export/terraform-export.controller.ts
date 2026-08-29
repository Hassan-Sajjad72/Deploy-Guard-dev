import { Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { TerraformExportService } from "./terraform-export.service";
@Controller("api/projects/:projectId/infrastructure/exports")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
export class TerraformExportController {
  constructor(private readonly service: TerraformExportService) {}
  @Post() create(@Req() req: Request, @Param("projectId") projectId: string) { return this.service.create(req.user!, projectId); }
  @Get(":artifactId/download") async download(@Req() req: Request, @Res() res: Response, @Param("projectId") projectId: string, @Param("artifactId") artifactId: string) { const artifact = await this.service.download(req.user!, projectId, artifactId); res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename}"`); res.setHeader("Cache-Control", "private, no-store"); res.send(artifact.archive); }
}
