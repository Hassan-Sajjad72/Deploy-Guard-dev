import { MigrationInterface, QueryRunner } from "typeorm";

type CheckSpec = {
  tableName: string;
  constraintName: string;
  acceptedDefinition: string;
  expression: string;
  invalidPredicate: string;
};

const CHECK_SPECS: CheckSpec[] = [
  {
    tableName: "infrastructure_destroy_operations",
    constraintName: "CHK_destroy_operations_fencing_token",
    acceptedDefinition:
      "CHECK (operation_fencing_token IS NULL"
      + " OR operation_fencing_token > 0)",
    expression:
      `"operation_fencing_token" IS NULL`
      + ` OR "operation_fencing_token" > 0`,
    invalidPredicate:
      `"operation_fencing_token" IS NOT NULL`
      + ` AND "operation_fencing_token" <= 0`,
  },
  {
    tableName: "project_pipeline_runs",
    constraintName: "CHK_project_pipeline_runs_execution_lane",
    acceptedDefinition:
      "CHECK (execution_lane IS NULL"
      + " OR (execution_lane::text = ANY"
      + " (ARRAY['release'::character varying,"
      + " 'infrastructure'::character varying,"
      + " 'deletion'::character varying]::text[])))",
    expression:
      `"execution_lane" IS NULL`
      + ` OR "execution_lane" IN ('release','infrastructure','deletion')`,
    invalidPredicate:
      `"execution_lane" IS NOT NULL`
      + ` AND "execution_lane" NOT IN ('release','infrastructure','deletion')`,
  },
  {
    tableName: "project_pipeline_runs",
    constraintName: "CHK_project_pipeline_runs_fencing_token",
    acceptedDefinition:
      "CHECK (operation_fencing_token IS NULL"
      + " OR operation_fencing_token > 0)",
    expression:
      `"operation_fencing_token" IS NULL`
      + ` OR "operation_fencing_token" > 0`,
    invalidPredicate:
      `"operation_fencing_token" IS NOT NULL`
      + ` AND "operation_fencing_token" <= 0`,
  },
  {
    tableName: "project_pipeline_runs",
    constraintName: "CHK_project_pipeline_runs_worker_protocol",
    acceptedDefinition:
      "CHECK (worker_protocol_version IS NULL"
      + " OR worker_protocol_version > 0)",
    expression:
      `"worker_protocol_version" IS NULL`
      + ` OR "worker_protocol_version" > 0`,
    invalidPredicate:
      `"worker_protocol_version" IS NOT NULL`
      + ` AND "worker_protocol_version" <= 0`,
  },
  {
    tableName: "release_manifests",
    constraintName: "CHK_release_manifest_initial_service_hash",
    acceptedDefinition:
      "CHECK (initial_service_input_hash IS NULL"
      + " OR initial_service_input_hash ~ '^[0-9a-f]{64}$'::text)",
    expression:
      `"initial_service_input_hash" IS NULL`
      + ` OR "initial_service_input_hash" ~ '^[0-9a-f]{64}$'`,
    invalidPredicate:
      `"initial_service_input_hash" IS NOT NULL`
      + ` AND "initial_service_input_hash" !~ '^[0-9a-f]{64}$'`,
  },
];

export class ValidateRuntimeSafetyChecks1760000052000
implements MigrationInterface {
  name = "ValidateRuntimeSafetyChecks1760000052000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const missing: CheckSpec[] = [];

    for (const spec of CHECK_SPECS) {
      const constraints: Array<{
        constraint_type: string;
        validated: boolean;
        definition: string;
      }> = await queryRunner.query(
        `
          SELECT constraint_row.contype AS constraint_type,
                 constraint_row.convalidated AS validated,
                 pg_get_constraintdef(
                   constraint_row.oid,
                   true
                 ) AS definition
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = $1::regclass
            AND constraint_row.conname = $2
        `,
        [`public.${spec.tableName}`, spec.constraintName],
      );

      if (
        constraints.length > 1
        || (constraints.length === 1
          && constraints[0].constraint_type !== "c")
      ) {
        throw new Error(
          `SCHEMA_CHECK_CONFLICT:${spec.tableName}.${spec.constraintName}`,
        );
      }

      if (constraints.length === 1) {
        if (constraints[0].definition !== spec.acceptedDefinition) {
          throw new Error(
            `SCHEMA_CHECK_DEFINITION_CONFLICT:${spec.tableName}.${spec.constraintName}`,
          );
        }
        if (!constraints[0].validated) {
          throw new Error(
            `SCHEMA_CHECK_UNVALIDATED:${spec.tableName}.${spec.constraintName}`,
          );
        }
        continue;
      }

      const invalidRows: Array<{ invalid_count: string }> =
        await queryRunner.query(
          `
            SELECT count(*)::text AS invalid_count
            FROM "${spec.tableName}"
            WHERE ${spec.invalidPredicate}
          `,
        );

      if (Number(invalidRows[0]?.invalid_count ?? 0) !== 0) {
        throw new Error(
          `SCHEMA_CHECK_DATA_CONFLICT:${spec.tableName}.${spec.constraintName}`,
        );
      }

      missing.push(spec);
    }

    for (const spec of missing) {
      await queryRunner.query(`
        ALTER TABLE "${spec.tableName}"
        ADD CONSTRAINT "${spec.constraintName}"
        CHECK (${spec.expression}) NOT VALID
      `);
      await queryRunner.query(`
        ALTER TABLE "${spec.tableName}"
        VALIDATE CONSTRAINT "${spec.constraintName}"
      `);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove validated runtime safety checks",
    );
  }
}
