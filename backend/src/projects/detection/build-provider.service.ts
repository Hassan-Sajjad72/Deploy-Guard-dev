import { Injectable } from "@nestjs/common";
import type { FrameworkDetectorResult } from "./framework-detector";
import { MainstreamDetectorResolverService } from "./mainstream-detector-resolver.service";

/**
 * The sole compilation boundary for generated image contracts.  Providers may
 * inspect repository evidence, but only this result is later persisted into a
 * BuildPlan; workflows and Terraform never rerun provider inference.
 */
export interface BuildProvider {
  readonly id: string;
  resolve(root: string, files: Set<string>): ReturnType<MainstreamDetectorResolverService["resolve"]>;
  resolveAll(root: string, files: Set<string>): ReturnType<MainstreamDetectorResolverService["resolveAll"]>;
  extract(root: string, files: Set<string>): ReturnType<MainstreamDetectorResolverService["extract"]>;
}

@Injectable()
export class DeployGuardBuildProvider implements BuildProvider {
  readonly id = "deployguard-generated/v1";
  constructor(private readonly resolver: MainstreamDetectorResolverService = new MainstreamDetectorResolverService()) {}
  resolve(root: string, files: Set<string>) { return this.resolver.resolve(root, files); }
  resolveAll(root: string, files: Set<string>) { return this.resolver.resolveAll(root, files); }
  extract(root: string, files: Set<string>) { return this.resolver.extract(root, files); }
}

/** Railpack is intentionally not registered until a pinned executable exists. */
export const RAILPACK_PROVIDER_STATUS = "DEFERRED — no pinned Railpack executable is available in this deployment engine" as const;
