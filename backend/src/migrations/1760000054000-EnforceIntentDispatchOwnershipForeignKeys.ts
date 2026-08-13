import { MigrationInterface, QueryRunner } from "typeorm";

type ForeignKeySpec = {
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  onDelete: "CASCADE" | "SET NULL" | "RESTRICT";
  deleteCode: "c" | "n" | "r";
};

const FOREIGN_KEYS: ForeignKeySpec[] = [
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_project",
    columnName: "project_id",
    referencedTableName: "projects",
    referencedColumnName: "id",
    onDelete: "CASCADE",
    deleteCode: "c",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_user",
    columnName: "requested_by_user_id",
    referencedTableName: "users",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_infrastructure_manifest",
    columnName: "infrastructure_manifest_id",
    referencedTableName: "infrastructure_manifests",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_release_manifest",
    columnName: "release_manifest_id",
    referencedTableName: "release_manifests",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_source_run",
    columnName: "source_pipeline_run_id",
    referencedTableName: "project_pipeline_runs",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_pipeline_run",
    columnName: "pipeline_run_id",
    referencedTableName: "project_pipeline_runs",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "deployment_intents",
    constraintName: "FK_deployment_intents_destroy_operation",
    columnName: "destroy_operation_id",
    referencedTableName: "infrastructure_destroy_operations",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "orchestration_outbox",
    constraintName: "FK_orchestration_outbox_intent",
    columnName: "intent_id",
    referencedTableName: "deployment_intents",
    referencedColumnName: "id",
    onDelete: "CASCADE",
    deleteCode: "c",
  },
  {
    tableName: "project_operation_leases",
    constraintName: "FK_project_operation_leases_project",
    columnName: "project_id",
    referencedTableName: "projects",
    referencedColumnName: "id",
    onDelete: "CASCADE",
    deleteCode: "c",
  },
  {
    tableName: "project_operation_leases",
    constraintName: "FK_project_operation_leases_intent",
    columnName: "intent_id",
    referencedTableName: "deployment_intents",
    referencedColumnName: "id",
    onDelete: "CASCADE",
    deleteCode: "c",
  },
  {
    tableName: "project_operation_leases",
    constraintName: "FK_project_operation_leases_pipeline_run",
    columnName: "pipeline_run_id",
    referencedTableName: "project_pipeline_runs",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "project_operation_leases",
    constraintName: "FK_project_operation_leases_destroy_operation",
    columnName: "destroy_operation_id",
    referencedTableName: "infrastructure_destroy_operations",
    referencedColumnName: "id",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "project_release_lane_ownerships",
    constraintName: "FK_release_lane_ownership_project",
    columnName: "project_id",
    referencedTableName: "projects",
    referencedColumnName: "id",
    onDelete: "CASCADE",
    deleteCode: "c",
  },
  {
    tableName: "project_release_lane_ownerships",
    constraintName: "FK_release_lane_ownership_intent",
    columnName: "deployment_intent_id",
    referencedTableName: "deployment_intents",
    referencedColumnName: "id",
    onDelete: "RESTRICT",
    deleteCode: "r",
  },
  {
    tableName: "project_release_lane_ownerships",
    constraintName: "FK_release_lane_ownership_operation_lease",
    columnName: "operation_lease_id",
    referencedTableName: "project_operation_leases",
    referencedColumnName: "id",
    onDelete: "RESTRICT",
    deleteCode: "r",
  },
];

export class EnforceIntentDispatchOwnershipForeignKeys1760000054000
implements MigrationInterface {
  name = "EnforceIntentDispatchOwnershipForeignKeys1760000054000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    const missing: ForeignKeySpec[] = [];

    for (const spec of FOREIGN_KEYS) {
      const columns: Array<{
        source_type: string;
        referenced_type: string;
      }> = await queryRunner.query(
        `
          SELECT format_type(source_attribute.atttypid, source_attribute.atttypmod)
                   AS source_type,
                 format_type(referenced_attribute.atttypid,
                   referenced_attribute.atttypmod) AS referenced_type
          FROM pg_attribute source_attribute
          JOIN pg_attribute referenced_attribute
            ON referenced_attribute.attrelid = $3::regclass
           AND referenced_attribute.attname = $4
           AND NOT referenced_attribute.attisdropped
          WHERE source_attribute.attrelid = $1::regclass
            AND source_attribute.attname = $2
            AND NOT source_attribute.attisdropped
        `,
        [
          `public.${spec.tableName}`,
          spec.columnName,
          `public.${spec.referencedTableName}`,
          spec.referencedColumnName,
        ],
      );

      if (
        columns.length !== 1
        || columns[0].source_type !== columns[0].referenced_type
      ) {
        throw new Error(
          `INTENT_OWNERSHIP_FK_TYPE_CONFLICT:${spec.constraintName}`,
        );
      }

      const referencedKeys: Array<{ key_count: string }> =
        await queryRunner.query(
          `
            SELECT count(*)::text AS key_count
            FROM pg_constraint key_constraint
            JOIN pg_attribute key_attribute
              ON key_attribute.attrelid = key_constraint.conrelid
             AND key_attribute.attnum = ANY(key_constraint.conkey)
            WHERE key_constraint.conrelid = $1::regclass
              AND key_constraint.contype IN ('p','u')
              AND array_length(key_constraint.conkey, 1) = 1
              AND key_attribute.attname = $2
          `,
          [
            `public.${spec.referencedTableName}`,
            spec.referencedColumnName,
          ],
        );

      if (Number(referencedKeys[0]?.key_count ?? 0) !== 1) {
        throw new Error(
          `INTENT_OWNERSHIP_FK_REFERENCE_KEY_CONFLICT:${spec.constraintName}`,
        );
      }

      const namedConstraints: Array<{
        constraint_type: string;
        validated: boolean;
        delete_code: string;
        update_code: string;
        source_column: string;
        referenced_table: string;
        referenced_column: string;
      }> = await queryRunner.query(
        `
          SELECT constraint_row.contype AS constraint_type,
                 constraint_row.convalidated AS validated,
                 constraint_row.confdeltype AS delete_code,
                 constraint_row.confupdtype AS update_code,
                 source_attribute.attname AS source_column,
                 constraint_row.confrelid::regclass::text
                   AS referenced_table,
                 referenced_attribute.attname AS referenced_column
          FROM pg_constraint constraint_row
          JOIN pg_attribute source_attribute
            ON source_attribute.attrelid = constraint_row.conrelid
           AND source_attribute.attnum = constraint_row.conkey[1]
          JOIN pg_attribute referenced_attribute
            ON referenced_attribute.attrelid = constraint_row.confrelid
           AND referenced_attribute.attnum = constraint_row.confkey[1]
          WHERE constraint_row.conrelid = $1::regclass
            AND constraint_row.conname = $2
        `,
        [`public.${spec.tableName}`, spec.constraintName],
      );

      if (namedConstraints.length > 1) {
        throw new Error(
          `INTENT_OWNERSHIP_FK_NAME_CONFLICT:${spec.constraintName}`,
        );
      }

      if (namedConstraints.length === 1) {
        const existing = namedConstraints[0];
        if (
          existing.constraint_type !== "f"
          || !existing.validated
          || existing.delete_code !== spec.deleteCode
          || existing.update_code !== "a"
          || existing.source_column !== spec.columnName
          || existing.referenced_table !== spec.referencedTableName
          || existing.referenced_column !== spec.referencedColumnName
        ) {
          throw new Error(
            `INTENT_OWNERSHIP_FK_DEFINITION_CONFLICT:${spec.constraintName}`,
          );
        }
        continue;
      }

      const equivalentConstraints: Array<{ constraint_name: string }> =
        await queryRunner.query(
          `
            SELECT constraint_row.conname AS constraint_name
            FROM pg_constraint constraint_row
            JOIN pg_attribute source_attribute
              ON source_attribute.attrelid = constraint_row.conrelid
             AND source_attribute.attnum = constraint_row.conkey[1]
            JOIN pg_attribute referenced_attribute
              ON referenced_attribute.attrelid = constraint_row.confrelid
             AND referenced_attribute.attnum = constraint_row.confkey[1]
            WHERE constraint_row.conrelid = $1::regclass
              AND constraint_row.contype = 'f'
              AND array_length(constraint_row.conkey, 1) = 1
              AND source_attribute.attname = $2
              AND constraint_row.confrelid = $3::regclass
              AND referenced_attribute.attname = $4
          `,
          [
            `public.${spec.tableName}`,
            spec.columnName,
            `public.${spec.referencedTableName}`,
            spec.referencedColumnName,
          ],
        );

      if (equivalentConstraints.length !== 0) {
        throw new Error(
          `INTENT_OWNERSHIP_FK_EQUIVALENT_NAME_CONFLICT:${spec.constraintName}`,
        );
      }

      const orphanRows: Array<{ orphan_count: string }> =
        await queryRunner.query(
          `
            SELECT count(*)::text AS orphan_count
            FROM "${spec.tableName}" source_row
            LEFT JOIN "${spec.referencedTableName}" referenced_row
              ON referenced_row."${spec.referencedColumnName}"
               = source_row."${spec.columnName}"
            WHERE source_row."${spec.columnName}" IS NOT NULL
              AND referenced_row."${spec.referencedColumnName}" IS NULL
          `,
        );

      if (Number(orphanRows[0]?.orphan_count ?? 0) !== 0) {
        throw new Error(
          `INTENT_OWNERSHIP_FK_ORPHAN_CONFLICT:${spec.constraintName}`,
        );
      }

      missing.push(spec);
    }

    for (const spec of missing) {
      await queryRunner.query(`
        ALTER TABLE "${spec.tableName}"
        ADD CONSTRAINT "${spec.constraintName}"
        FOREIGN KEY ("${spec.columnName}")
        REFERENCES "${spec.referencedTableName}"("${spec.referencedColumnName}")
        ON UPDATE NO ACTION
        ON DELETE ${spec.onDelete}
        NOT VALID
      `);
      await queryRunner.query(`
        ALTER TABLE "${spec.tableName}"
        VALIDATE CONSTRAINT "${spec.constraintName}"
      `);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove validated intent dispatch and ownership foreign keys",
    );
  }
}
