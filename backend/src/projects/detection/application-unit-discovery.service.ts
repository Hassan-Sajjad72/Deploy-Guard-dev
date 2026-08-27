import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { FrameworkDetectorResult } from "./framework-detector";
import type { RepositoryEvidence } from "./repository-evidence.types";

export type ApplicationUnitCandidate = {
  root: string;
  absoluteRoot: string;
  files: Set<string>;
  manifests: string[];
  matches: FrameworkDetectorResult[];
};

export type DiscoveredApplicationUnit = ApplicationUnitCandidate & {
  id: string;
  deployable: boolean;
  evidence: RepositoryEvidence[];
};

/** Bounded unit discovery. Directory names are deliberately not consulted. */
export class ApplicationUnitDiscoveryService {
  discover(repositoryRoot: string, candidates: ApplicationUnitCandidate[]): DiscoveredApplicationUnit[] {
    return candidates
      .map((candidate, index) => {
        const packageJson = this.json(join(candidate.absoluteRoot, "package.json"));
        const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
        const runtimeMatch = candidate.matches.some((match) => match.partialBuildPlan.runtimeType === "server" && Boolean(match.partialBuildPlan.runCommand));
        const buildMatch = candidate.matches.some((match) => match.partialBuildPlan.runtimeType === "static" && Boolean(match.partialBuildPlan.buildCommand));
        const pythonRuntime = candidate.matches.some((match) => match.language === "python" && Boolean(match.partialBuildPlan.runCommand));
        const independentCommands = Boolean(scripts.start || scripts["start:prod"] || scripts.build);
        const incompleteRootApplication = candidate.root === "." && candidate.matches.some((match) => match.requiredUserInputs.length > 0);
        const deployable = runtimeMatch || buildMatch || pythonRuntime || independentCommands || incompleteRootApplication;
        const evidence: RepositoryEvidence[] = candidate.manifests.map((file) => ({
          kind: "manifest",
          file: candidate.root === "." ? file : `${candidate.root}/${file}`,
          root: candidate.root,
          confidence: "direct",
        }));
        if (packageJson?.workspaces) evidence.push({ kind: "workspace", file: candidate.root === "." ? "package.json" : `${candidate.root}/package.json`, root: candidate.root, value: JSON.stringify(packageJson.workspaces), confidence: "direct" });
        for (const match of candidate.matches) {
          evidence.push({ kind: "framework", technology: match.framework, file: candidate.root === "." ? "package.json" : `${candidate.root}/package.json`, root: candidate.root, value: match.frameworkMode, confidence: match.confidence >= 0.9 ? "direct" : match.confidence >= 0.75 ? "strong" : "weak", references: match.evidence.map((item) => item.source) });
          if (match.partialBuildPlan.buildCommand) evidence.push({ kind: "build-script", technology: match.framework, file: candidate.root === "." ? "package.json" : `${candidate.root}/package.json`, root: candidate.root, value: match.partialBuildPlan.buildCommand, confidence: "direct" });
          if (match.partialBuildPlan.runCommand) evidence.push({ kind: "start-script", technology: match.framework, file: candidate.root === "." ? "package.json" : `${candidate.root}/package.json`, root: candidate.root, value: match.partialBuildPlan.runCommand, confidence: "direct" });
          if (match.partialBuildPlan.outputDirectory) evidence.push({ kind: "static-output", technology: match.framework, file: candidate.root === "." ? "package.json" : `${candidate.root}/package.json`, root: candidate.root, value: match.partialBuildPlan.outputDirectory, confidence: "strong" });
        }
        return { ...candidate, id: `unit-${index + 1}`, deployable, evidence };
      })
      .filter((unit) => unit.deployable || unit.evidence.some((item) => item.kind === "workspace"));
  }

  private json(path: string) {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  }
}
