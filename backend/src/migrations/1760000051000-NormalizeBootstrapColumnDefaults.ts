import { MigrationInterface, QueryRunner } from "typeorm";

type DefaultSpec = {
  tableName: string;
  columnName: string;
  acceptedCurrent: Array<string | null>;
  desired: string | null;
  alterSql: string;
};

const DEFAULT_SPECS: DefaultSpec[] = [
  {
    tableName: "project_environment_variables",
    columnName: "encryption_version",
    acceptedCurrent: ["0", "1"],
    desired: "1",
    alterSql: `ALTER TABLE "project_environment_variables"
      ALTER COLUMN "encryption_version" SET DEFAULT 1`,
  },
  {
    tableName: "billing_accounts",
    columnName: "provider",
    acceptedCurrent: ["'demo'::character varying", "'none'::character varying"],
    desired: "'none'::character varying",
    alterSql: `ALTER TABLE "billing_accounts"
      ALTER COLUMN "provider" SET DEFAULT 'none'`,
  },
  {
    tableName: "billing_accounts",
    columnName: "mode",
    acceptedCurrent: [
      "'demo'::character varying",
      "'not_configured'::character varying",
    ],
    desired: "'not_configured'::character varying",
    alterSql: `ALTER TABLE "billing_accounts"
      ALTER COLUMN "mode" SET DEFAULT 'not_configured'`,
  },
  {
    tableName: "billing_subscriptions",
    columnName: "provider",
    acceptedCurrent: ["'demo'::character varying", "'none'::character varying"],
    desired: "'none'::character varying",
    alterSql: `ALTER TABLE "billing_subscriptions"
      ALTER COLUMN "provider" SET DEFAULT 'none'`,
  },
  {
    tableName: "billing_subscriptions",
    columnName: "mode",
    acceptedCurrent: [
      "'demo'::character varying",
      "'not_configured'::character varying",
    ],
    desired: "'not_configured'::character varying",
    alterSql: `ALTER TABLE "billing_subscriptions"
      ALTER COLUMN "mode" SET DEFAULT 'not_configured'`,
  },
  {
    tableName: "project_cloud_states",
    columnName: "last_verification_reason",
    acceptedCurrent: ["'Cloud verification has not run.'::text", null],
    desired: null,
    alterSql: `ALTER TABLE "project_cloud_states"
      ALTER COLUMN "last_verification_reason" DROP DEFAULT`,
  },
];

export class NormalizeBootstrapColumnDefaults1760000051000
implements MigrationInterface {
  name = "NormalizeBootstrapColumnDefaults1760000051000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const pending: DefaultSpec[] = [];

    for (const spec of DEFAULT_SPECS) {
      const rows: Array<{ column_default: string | null }> =
        await queryRunner.query(
          `
            SELECT column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
              AND column_name = $2
          `,
          [spec.tableName, spec.columnName],
        );

      if (rows.length !== 1) {
        throw new Error(
          `SCHEMA_DEFAULT_COLUMN_MISSING:${spec.tableName}.${spec.columnName}`,
        );
      }

      const current = rows[0].column_default;
      if (!spec.acceptedCurrent.includes(current)) {
        throw new Error(
          `SCHEMA_DEFAULT_CONFLICT:${spec.tableName}.${spec.columnName}`,
        );
      }

      if (current !== spec.desired) {
        pending.push(spec);
      }
    }

    for (const spec of pending) {
      await queryRunner.query(spec.alterSql);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to restore superseded bootstrap defaults",
    );
  }
}
