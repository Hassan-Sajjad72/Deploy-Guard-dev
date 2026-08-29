import { MigrationInterface, QueryRunner } from "typeorm";

/** Retire the removed image-scan/review feature without rewriting historical migrations. */
export class RemoveImageSecurityReview1787356801000 implements MigrationInterface {
  name = "RemoveImageSecurityReview1787356801000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "project_pipeline_runs"
      SET
        "status" = 'failed',
        "current_stage" = 'workflow_retired',
        "failed_at" = COALESCE("failed_at", now()),
        "error_message" = 'This operation used a retired image-review workflow. Start a new deployment.',
        "metadata" = COALESCE("metadata", '{}'::jsonb)
          - 'securityState'
          - 'securityScanId'
          - 'securityEvidenceHash'
          - 'securityComponentImages'
          - 'securityDecision'
          - 'securityReviewWorkflowRunId'
          - 'securityReviewReconciliationAttempts'
          - 'continuationDispatchInputs'
      WHERE "status"::text IN ('waiting_for_security_review', 'security_rejected')
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_security_findings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_security_scans"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_metric_summaries" DROP COLUMN IF EXISTS "trivy_scan_duration_ms"`);
  }

  async down(): Promise<void> {
    // Deliberately irreversible: retired scan evidence is not restored as active product state.
  }
}
