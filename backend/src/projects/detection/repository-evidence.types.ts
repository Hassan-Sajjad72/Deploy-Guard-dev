export type EvidenceKind =
  | "framework"
  | "manifest"
  | "package-manager"
  | "workspace"
  | "entrypoint"
  | "build-script"
  | "start-script"
  | "dependency"
  | "config"
  | "static-output"
  | "serves-static"
  | "proxy"
  | "env-reference"
  | "database"
  | "port"
  | "health-route"
  | "docker"
  | "compose";

export type EvidenceConfidence = "direct" | "strong" | "weak";

/** A repository fact. This type deliberately contains no deployment decision. */
export type RepositoryEvidence = {
  kind: EvidenceKind;
  technology?: string;
  file: string;
  root: string;
  value?: string;
  confidence: EvidenceConfidence;
  references?: string[];
};
