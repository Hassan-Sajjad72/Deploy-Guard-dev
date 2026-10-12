import { MigrationInterface, QueryRunner } from "typeorm";

export class SessionRevocation1791676800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE auth_session_revocations (token_hash varchar(64) PRIMARY KEY, expires_at timestamptz NOT NULL)`);
    await runner.query(`CREATE INDEX "IDX_auth_session_revocations_expires_at" ON auth_session_revocations (expires_at)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE auth_session_revocations`);
  }
}
