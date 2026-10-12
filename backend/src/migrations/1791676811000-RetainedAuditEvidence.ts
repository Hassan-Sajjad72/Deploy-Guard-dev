import { MigrationInterface, QueryRunner } from "typeorm";

export class RetainedAuditEvidence1791676811000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE FUNCTION retain_privileged_audit_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit evidence is immutable'; END $$`);
    await runner.query(`CREATE TRIGGER retain_audit_evidence BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION retain_privileged_audit_evidence()`);
  }
  async down(runner: QueryRunner) {
    const [{ retained }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM audit_logs) AS retained`);
    if (retained) throw new Error("Retained audit evidence prevents rollback.");
    await runner.query(`DROP TRIGGER retain_audit_evidence ON audit_logs`);
    await runner.query(`DROP FUNCTION retain_privileged_audit_evidence()`);
  }
}
