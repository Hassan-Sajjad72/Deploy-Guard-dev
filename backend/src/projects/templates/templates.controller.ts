import { Controller, Get, UseGuards } from "@nestjs/common";
import { requireRole } from "../../common/rbac/require-role.guard";
import { UserRole } from "../../users/user.entity";
import { TemplateRegistryService } from "./template-registry.service";

@Controller("api/templates")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class TemplatesController {
  constructor(private readonly templateRegistryService: TemplateRegistryService) {}

  @Get()
  listTemplates() {
    return { templates: this.templateRegistryService.listTemplates() };
  }
}
