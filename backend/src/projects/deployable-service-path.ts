import { BadRequestException } from "@nestjs/common";

export const MAX_SERVICE_DIRECTORY_LENGTH = 512;

/** Canonical repository-relative service scope. This performs no source inference. */
export function normalizeServiceDirectory(value: unknown): string {
  const raw = String(value ?? ".").trim();
  if (!raw || raw === "." || raw === "./") return ".";
  if (raw.includes("\0") || raw.length > MAX_SERVICE_DIRECTORY_LENGTH || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new BadRequestException({ code: "DG_SERVICE_DIRECTORY_INVALID", message: "Service directory must be a bounded repository-relative path." });
  }
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === ".." || segment === ".")) {
    throw new BadRequestException({ code: "DG_SERVICE_DIRECTORY_INVALID", message: "Service directory cannot escape the repository." });
  }
  return normalized;
}
