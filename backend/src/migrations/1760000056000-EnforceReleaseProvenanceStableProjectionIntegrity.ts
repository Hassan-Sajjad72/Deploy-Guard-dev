import { MigrationInterface, QueryRunner } from "typeorm";

type ForeignKeySpec = {
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  onDelete: "SET NULL" | "RESTRICT";
  deleteCode: "n" | "r";
};

const FOREIGN_KEYS: readonly ForeignKeySpec[] = [
  {
    tableName: "release_image_provenances",
    constraintName: "FK_release_image_provenance_intent",
    columnName: "intent_id",
    referencedTableName: "deployment_intents",
    onDelete: "RESTRICT",
    deleteCode: "r",
  },
  {
    tableName: "release_image_provenances",
    constraintName: "FK_release_image_provenance_infrastructure",
    columnName: "infrastructure_manifest_id",
    referencedTableName: "infrastructure_manifests",
    onDelete: "RESTRICT",
    deleteCode: "r",
  },
  {
    tableName: "project_stable_releases",
    constraintName: "FK_releases_run",
    columnName: "deployed_by_pipeline_run_id",
    referencedTableName: "project_pipeline_runs",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
  {
    tableName: "project_stable_releases",
    constraintName: "FK_project_stable_releases_release_manifest",
    columnName: "release_manifest_id",
    referencedTableName: "release_manifests",
    onDelete: "SET NULL",
    deleteCode: "n",
  },
];

/**
 * Restores immutable provenance and stable-projection integrity only after
 * validating the existing data. The project key is deliberately absent here:
 * the operational schema already has TypeORM's equivalent CASCADE key under
 * its deterministic metadata name.
 */
export class EnforceReleaseProvenanceStableProjectionIntegrity1760000056000
  implements MigrationInterface
{
  name = "EnforceReleaseProvenanceStableProjectionIntegrity1760000056000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    const missing: ForeignKeySpec[] = [];
    for (const spec of FOREIGN_KEYS) {
      const types: Array<{ source_type: string; target_type: string }> =
        await queryRunner.query(
          `SELECT format_type(source_column.atttypid, source_column.atttypmod) AS source_type,
                  format_type(target_column.atttypid, target_column.atttypmod) AS target_type
             FROM pg_attribute source_column
             JOIN pg_attribute target_column
               ON target_column.attrelid = $3::regclass
              AND target_column.attname = 'id'
              AND NOT target_column.attisdropped
            WHERE source_column.attrelid = $1::regclass
              AND source_column.attname = $2
              AND NOT source_column.attisdropped`,
          [
            `public.${spec.tableName}`,
            spec.columnName,
            `public.${spec.referencedTableName}`,
          ],
        );
      if (types.length !== 1 || types[0].source_type !== types[0].target_type) {
        throw new Error(`RELEASE_PROVENANCE_FK_TYPE_CONFLICT:${spec.constraintName}`);
      }

      const keys: Array<{ count: string }> = await queryRunner.query(
        `SELECT count(*)::text AS count
           FROM pg_constraint
          WHERE conrelid = $1::regclass
            AND contype IN ('p', 'u')
            AND array_length(conkey, 1) = 1
            AND conkey[1] = (
              SELECT attnum FROM pg_attribute
               WHERE attrelid = $1::regclass AND attname = 'id'
                 AND NOT attisdropped
            )`,
        [`public.${spec.referencedTableName}`],
      );
      if (Number(keys[0]?.count ?? 0) !== 1) {
        throw new Error(`RELEASE_PROVENANCE_FK_REFERENCE_KEY_CONFLICT:${spec.constraintName}`);
      }

      const named: Array<{
        contype: string;
        convalidated: boolean;
        confdeltype: string;
        confupdtype: string;
        source_column: string;
        referenced_table: string;
      }> = await queryRunner.query(
        `SELECT constraint_row.contype, constraint_row.convalidated,
                constraint_row.confdeltype, constraint_row.confupdtype,
                source_column.attname AS source_column,
                constraint_row.confrelid::regclass::text AS referenced_table
           FROM pg_constraint constraint_row
           JOIN pg_attribute source_column
             ON source_column.attrelid = constraint_row.conrelid
            AND source_column.attnum = constraint_row.conkey[1]
          WHERE constraint_row.conrelid = $1::regclass
            AND constraint_row.conname = $2`,
        [`public.${spec.tableName}`, spec.constraintName],
      );
      if (named.length > 1) {
        throw new Error(`RELEASE_PROVENANCE_FK_NAME_CONFLICT:${spec.constraintName}`);
      }
      if (named.length === 1) {
        const current = named[0];
        if (
          current.contype !== "f"
          || !current.convalidated
          || current.confdeltype !== spec.deleteCode
          || current.confupdtype !== "a"
          || current.source_column !== spec.columnName
          || current.referenced_table !== spec.referencedTableName
        ) {
          throw new Error(`RELEASE_PROVENANCE_FK_DEFINITION_CONFLICT:${spec.constraintName}`);
        }
        continue;
      }

      const equivalent: Array<{ conname: string }> = await queryRunner.query(
        `SELECT constraint_row.conname
           FROM pg_constraint constraint_row
           JOIN pg_attribute source_column
             ON source_column.attrelid = constraint_row.conrelid
            AND source_column.attnum = constraint_row.conkey[1]
          WHERE constraint_row.conrelid = $1::regclass
            AND constraint_row.contype = 'f'
            AND array_length(constraint_row.conkey, 1) = 1
            AND source_column.attname = $2
            AND constraint_row.confrelid = $3::regclass`,
        [
          `public.${spec.tableName}`,
          spec.columnName,
          `public.${spec.referencedTableName}`,
        ],
      );
      if (equivalent.length !== 0) {
        throw new Error(`RELEASE_PROVENANCE_FK_EQUIVALENT_NAME_CONFLICT:${spec.constraintName}`);
      }

      const orphanRows: Array<{ count: string }> = await queryRunner.query(
        `SELECT count(*)::text AS count
           FROM "${spec.tableName}" source_row
           LEFT JOIN "${spec.referencedTableName}" target_row
             ON target_row.id = source_row."${spec.columnName}"
          WHERE source_row."${spec.columnName}" IS NOT NULL
            AND target_row.id IS NULL`,
      );
      if (Number(orphanRows[0]?.count ?? 0) !== 0) {
        throw new Error(`RELEASE_PROVENANCE_FK_ORPHAN_CONFLICT:${spec.constraintName}`);
      }
      missing.push(spec);
    }

    for (const spec of missing) {
      await queryRunner.query(
        `ALTER TABLE "${spec.tableName}"
           ADD CONSTRAINT "${spec.constraintName}"
           FOREIGN KEY ("${spec.columnName}")
           REFERENCES "${spec.referencedTableName}"("id")
           ON UPDATE NO ACTION ON DELETE ${spec.onDelete} NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE "${spec.tableName}"
           VALIDATE CONSTRAINT "${spec.constraintName}"`,
      );
    }

    const indexRows: Array<{
      index_name: string;
      indisunique: boolean;
      has_predicate: boolean;
      key_count: string;
      key_column: string;
    }> = await queryRunner.query(
      `SELECT index_class.relname AS index_name,
              index_row.indisunique,
              index_row.indpred IS NOT NULL AS has_predicate,
              index_row.indnkeyatts::text AS key_count,
              attribute.attname AS key_column
         FROM pg_index index_row
         JOIN pg_class table_class ON table_class.oid = index_row.indrelid
         JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
         JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
         JOIN pg_attribute attribute
           ON attribute.attrelid = table_class.oid
          AND attribute.attnum = index_row.indkey[0]
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname = 'release_image_provenances'
          AND index_row.indnkeyatts = 1
          AND attribute.attname = 'intent_id'`,
    );
    const canonicalIndex = "IDX_release_image_provenance_intent";
    const namedIndex = indexRows.find((row) => row.index_name === canonicalIndex);
    if (namedIndex && (namedIndex.indisunique || namedIndex.has_predicate || namedIndex.key_count !== "1")) {
      throw new Error("RELEASE_PROVENANCE_INDEX_DEFINITION_CONFLICT");
    }
    if (!namedIndex && indexRows.length === 0) {
      await queryRunner.query(
        `CREATE INDEX "IDX_release_image_provenance_intent"
           ON "release_image_provenances" ("intent_id")`,
      );
    } else if (!namedIndex && indexRows.length > 0) {
      throw new Error("RELEASE_PROVENANCE_INDEX_EQUIVALENT_NAME_CONFLICT");
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove validated release provenance and stable projection integrity",
    );
  }
}
