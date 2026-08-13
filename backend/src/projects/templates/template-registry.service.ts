import { Injectable } from "@nestjs/common";
import {
  DEVOPS_TEMPLATES,
  DevOpsTemplateDefinition,
} from "./devops-templates";

@Injectable()
export class TemplateRegistryService {
  listTemplates() {
    return DEVOPS_TEMPLATES;
  }

  getTemplate(templateKey: string): DevOpsTemplateDefinition | null {
    return (
      DEVOPS_TEMPLATES.find((template) => template.templateKey === templateKey) ||
      null
    );
  }

  isSupported(templateKey: string) {
    return Boolean(this.getTemplate(templateKey));
  }
}
