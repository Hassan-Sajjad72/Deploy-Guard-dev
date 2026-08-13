import { Injectable } from "@nestjs/common";

export type CurrentStateInvalidation = {
  generation: number;
  invalidatedAt: string | null;
  reason: string | null;
};

@Injectable()
export class CurrentStateInvalidationService {
  private readonly revisions = new Map<string, CurrentStateInvalidation>();

  invalidate(projectId: string, reason: string) {
    const previous = this.revisions.get(projectId);
    const revision = {
      generation: (previous?.generation || 0) + 1,
      invalidatedAt: new Date().toISOString(),
      reason,
    };
    this.revisions.set(projectId, revision);
    return revision;
  }

  current(projectId: string): CurrentStateInvalidation {
    return this.revisions.get(projectId) || { generation: 0, invalidatedAt: null, reason: null };
  }
}
