export type ReleaseServiceLineageNode = {
  id: string;
  previousStableManifestId: string | null;
  initialServiceArn: string | null;
};

/**
 * Resolve the long-lived service identity without mutating historical release
 * evidence. Every ancestor lookup remains the caller's exact scoped query.
 */
export async function resolveReleaseServiceArn(
  stable: ReleaseServiceLineageNode,
  loadAncestor: (
    releaseManifestId: string,
  ) => Promise<ReleaseServiceLineageNode | null>,
  maximumDepth = 32,
) {
  let current: ReleaseServiceLineageNode | null = stable;
  const visited = new Set<string>();
  for (let depth = 0; current && depth < maximumDepth; depth += 1) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (current.initialServiceArn) return current.initialServiceArn;
    if (!current.previousStableManifestId) return null;
    current = await loadAncestor(current.previousStableManifestId);
  }
  return null;
}
