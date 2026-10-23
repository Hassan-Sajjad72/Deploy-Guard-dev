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
      };
    }

    const frameworkTemplates = new Set([
      "nextjs-ssr",
      "nextjs-static",
      "express-server",
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
      };
    }

    if (draft.ecosystem === "node") {
      return {
        selectedTemplate: "generic-node",
        dockerfileRequired: false,
        detectionStatus: "success",
      };
    }

    if (draft.ecosystem === "python") {
      return {
        selectedTemplate: "generic-python",
        dockerfileRequired: false,
        detectionStatus: "success",
      };
    }

    if (draft.ecosystem === "ruby") {
      return {
        selectedTemplate: "generic-ruby",
        dockerfileRequired: false,
        detectionStatus: "success",
      };
    }

    return {
      selectedTemplate: "custom-dockerfile-required",
      dockerfileRequired: true,
      detectionStatus: "needs_manual_dockerfile",
    };
  }
}
