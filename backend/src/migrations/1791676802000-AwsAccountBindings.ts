import { MigrationInterface, QueryRunner } from "typeorm";

export class AwsAccountBindings1791676802000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE aws_account_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      account_id varchar(12) NOT NULL CHECK (account_id ~ '^[0-9]{12}$'), role_arn varchar NOT NULL, external_id varchar NOT NULL,
      regions jsonb NOT NULL CHECK (jsonb_typeof(regions) = 'array'),
      verification_status varchar NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'failed', 'revoked')),
      verification_version integer NOT NULL DEFAULT 0, verified_at timestamptz, verification_evidence jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, account_id, role_arn))`);
  }
  async down(runner: QueryRunner): Promise<void> { await runner.query(`DROP TABLE aws_account_bindings`); }
}
