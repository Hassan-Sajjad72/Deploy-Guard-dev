import {
  V1FirstReleaseBootstrapClient,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseImageBuildRequest,
  V1FirstReleaseHealthEvidence,
  V1FirstReleaseHealthRequest,
  V1FirstReleaseServiceRequest,
  V1FirstReleaseTaskDefinitionRequest,
} from "./inactive-v1-first-release-bootstrap.types";
import { V1HandlerSideEffectExecutorContext } from "./v1-handler-side-effect.types";

/**
 * Composition-time sentinel. It deliberately cannot build, push, register, or
 * create anything. A later explicitly-approved activation must replace it.
 */
export class DisabledV1FirstReleaseBootstrapClient
implements V1FirstReleaseBootstrapClient {
  readonly policy = "deployguard.first-release-bootstrap/client-v1" as const;

  async buildAndPushImmutableImage(
    _input: V1FirstReleaseImageBuildRequest,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }

  async resolveImmutableImageEvidence(
    _input: V1FirstReleaseImageBuildRequest,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }

  async inspectExactService(
    _input: { clusterArn: string; serviceName: string; infrastructureManifestId: string; infrastructureRevision: string },
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ state: "absent" | "present" | "ambiguous" }> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }

  async registerInitialTaskDefinition(
    _input: V1FirstReleaseTaskDefinitionRequest,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ taskDefinitionArn: string }> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }

  async createInitialService(
    _input: V1FirstReleaseServiceRequest,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ serviceArn: string }> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }

  async verifyInitialRelease(
    _input: V1FirstReleaseHealthRequest,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseHealthEvidence> {
    throw new Error("FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED");
  }
}
