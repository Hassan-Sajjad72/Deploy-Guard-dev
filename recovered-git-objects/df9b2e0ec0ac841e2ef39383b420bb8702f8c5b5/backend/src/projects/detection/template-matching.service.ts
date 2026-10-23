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

    if (draft.frameworkVariant === "react-native-mobile") {
      return {
        selectedTemplate: "custom-dockerfile-required",
        dockerfileRequired: true,
        detectionStatus: "needs_manual_dockerfile",
        templateMatched: false,
        unsupportedReason: "React Native mobile applications do not expose an HTTP web service for ECS and ALB. Provide an explicit web target or deploy a web repository.",
      };
    }

    const frameworkTemplates = new Set([
      "nextjs-ssr",
      "nextjs-static",
      "express-server",
      "nestjs-server",
      "fastify-server",
      "vite-static",
      "react-static",
      "django-wsgi",
      "fastapi-asgi",
      "flask-wsgi",
      "streamlit-server",
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
