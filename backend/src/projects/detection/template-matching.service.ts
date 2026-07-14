import { Injectable } from "@nestjs/common";

export type DetectionDraft = {
  hasDockerfile: boolean;
  frameworkVariant: string | null;
  ecosystem: string;
};

@Injectable()
export class TemplateMatchingService {
  selectTemplate(draft: DetectionDraft) {
    if (draft.hasDockerfile) {
      return {
        selectedTemplate: "custom-dockerfile",
        dockerfileRequired: false,
        detectionStatus: "success",
        templateMatched: true,
        unsupportedReason: null,
      };
    }

    const frameworkTemplates = new Set([
      "nextjs-ssr",
      "nextjs-static",
      "express-server",
      "vite-static",
      "django-wsgi",
      "fastapi-asgi",
      "flask-wsgi",
      "rails-server",
    ]);

    if (draft.frameworkVariant && frameworkTemplates.has(draft.frameworkVariant)) {
      return {
        selectedTemplate: draft.frameworkVariant,
        dockerfileRequired: false,
        detectionStatus: "success",
        templateMatched: true,
        unsupportedReason: null,
      };
    }

    if (draft.ecosystem === "node") {
      return {
        selectedTemplate: "generic-node",
        dockerfileRequired: false,
        detectionStatus: "success",
        templateMatched: true,
        unsupportedReason: null,
      };
    }

    if (draft.ecosystem === "python") {
      return {
        selectedTemplate: "generic-python",
        dockerfileRequired: false,
        detectionStatus: "success",
        templateMatched: true,
        unsupportedReason: null,
      };
    }

    if (draft.ecosystem === "php") {
      return {
        selectedTemplate: "custom-dockerfile-required",
        dockerfileRequired: true,
        detectionStatus: "needs_manual_dockerfile",
        templateMatched: false,
        unsupportedReason: "Stack detected but PHP template is not supported yet.",
      };
    }

    if (draft.ecosystem === "ruby") {
      return {
        selectedTemplate: "custom-dockerfile-required",
        dockerfileRequired: true,
        detectionStatus: "needs_manual_dockerfile",
        templateMatched: false,
        unsupportedReason: "Stack detected but Ruby template is not supported yet.",
      };
    }

    return {
      selectedTemplate: "custom-dockerfile-required",
      dockerfileRequired: true,
      detectionStatus: "needs_manual_dockerfile",
      templateMatched: false,
      unsupportedReason: null,
    };
  }
}
