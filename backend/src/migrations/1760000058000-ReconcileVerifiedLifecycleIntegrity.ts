import { MigrationInterface, QueryRunner } from "typeorm";

type DeleteAction = "CASCADE" | "SET NULL";

export type VerifiedLifecycleForeignKey = {
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  onDelete: DeleteAction;
  deleteCode: "c" | "n";
};

export const VERIFIED_LIFECYCLE_FOREIGN_KEYS:
readonly VerifiedLifecycleForeignKey[] = [
  { tableName: "infrastructure_destroy_operations", constraintName: "FK_destroy_operations_deployment_intent", columnName: "deployment_intent_id", referencedTableName: "deployment_intents", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "infrastructure_destroy_operations", constraintName: "FK_destroy_operations_infrastructure_manifest", columnName: "infrastructure_manifest_id", referencedTableName: "infrastructure_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_cost_estimates", constraintName: "FK_project_cost_estimates_approved_by_user", columnName: "approved_by_user_id", referencedTableName: "users", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_cost_estimates", constraintName: "FK_project_cost_estimates_rejected_by_user", columnName: "rejected_by_user_id", referencedTableName: "users", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_orchestration_events", constraintName: "FK_orchestration_events_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "projects", constraintName: "FK_projects_deletion_intent", columnName: "deletion_intent_id", referencedTableName: "deployment_intents", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
];

export type VerifiedProjectIdentityIndex = {
  indexName: string;
  keyItems: readonly string[];
  predicate: string;
  duplicateGroupSql: string;
  createSql: string;
};

export const VERIFIED_PROJECT_IDENTITY_INDEXES:
readonly VerifiedProjectIdentityIndex[] = [
  {
    indexName: "UQ_active_project_github_branch_environment",
    keyItems: ["owner_user_id", "github_repository_id", "target_branch", "environment_name"],
    predicate: "github_repository_id IS NOT NULL AND archived_at IS NULL",
    duplicateGroupSql: `
      SELECT count(*)::text AS count
        FROM (
          SELECT owner_user_id, github_repository_id, target_branch, environment_name
            FROM projects
           WHERE github_repository_id IS NOT NULL AND archived_at IS NULL
           GROUP BY owner_user_id, github_repository_id, target_branch, environment_name
          HAVING count(*) > 1
        ) duplicate_group`,
    createSql: `CREATE UNIQUE INDEX "UQ_active_project_github_branch_environment"
                  ON "projects" ("owner_user_id", "github_repository_id", "target_branch", "environment_name")
               WHERE "github_repository_id" IS NOT NULL AND "archived_at" IS NULL`,
  },
  {
    indexName: "UQ_active_project_repository_branch_environment",
    keyItems: ["owner_user_id", "lower(repository_full_name::text)", "target_branch", "environment_name"],
    predicate: "archived_at IS NULL",
    duplicateGroupSql: `
      SELECT count(*)::text AS count
        FROM (
          SELECT owner_user_id, lower(repository_full_name), target_branch, environment_name
            FROM projects
           WHERE archived_at IS NULL
           GROUP BY owner_user_id, lower(repository_full_name), target_branch, environment_name
          HAVING count(*) > 1
        ) duplicate_group`,
    createSql: `CREATE UNIQUE INDEX "UQ_active_project_repository_branch_environment"
                  ON "projects" ("owner_user_id", lower("repository_full_name"), "target_branch", "environment_name")
               WHERE "archived_at" IS NULL`,
  },
];

type CurrentIndex = {
  index_name: string;
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  access_method: string;
  key_count: number;
  key_items: string[];
  predicate: string | null;
};

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Restores only relationships and active-project identity guards that were
 * proven safe on a data-bearing clone. It deliberately leaves retained
 * historical Terraform-lock orphans untouched.
 */
export class ReconcileVerifiedLifecycleIntegrity1760000058000
implements MigrationInterface {
  name = "ReconcileVerifiedLifecycleIntegrity1760000058000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    for (const spec of VERIFIED_LIFECYCLE_FOREIGN_KEYS) {
      await this.ensureForeignKey(queryRunner, spec);
    }
    await this.requireProjectIdentityColumnTypes(queryRunner);
    for (const spec of VERIFIED_PROJECT_IDENTITY_INDEXES) {
      await this.ensureProjectIdentityIndex(queryRunner, spec);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove verified lifecycle integrity constraints and indexes",
    );
  }

  private async ensureForeignKey(
    queryRunner: QueryRunner,
    spec: VerifiedLifecycleForeignKey,
  ): Promise<void> {
    const sourceTable = `public.${spec.tableName}`;
    const targetTable = `public.${spec.referencedTableName}`;
    const types: Array<{ source_type: string; target_type: string }> =
      await queryRunner.query(
        `SELECT format_type(source_column.atttypid, source_column.atttypmod) AS source_type,
                format_type(target_column.atttypid, target_column.atttypmod) AS target_type
           FROM pg_attribute source_column
           JOIN pg_attribute target_column
             ON target_column.attrelid = $3::regclass
            AND target_column.attname = $4
            AND NOT target_column.attisdropped
          WHERE source_column.attrelid = $1::regclass
            AND source_column.attname = $2
            AND NOT source_column.attisdropped`,
        [sourceTable, spec.columnName, targetTable, spec.referencedColumnName],
      );
    if (types.length !== 1 || types[0].source_type !== types[0].target_type) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_TYPE_CONFLICT:${spec.constraintName}`);
    }

    const keys: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM pg_constraint target_key
        WHERE target_key.conrelid = $1::regclass
          AND target_key.contype IN ('p', 'u')
          AND array_length(target_key.conkey, 1) = 1
          AND target_key.conkey[1] = (
            SELECT attnum FROM pg_attribute
             WHERE attrelid = $1::regclass
               AND attname = $2
               AND NOT attisdropped
          )`,
      [targetTable, spec.referencedColumnName],
    );
    if (Number(keys[0]?.count ?? 0) !== 1) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_REFERENCE_KEY_CONFLICT:${spec.constraintName}`);
    }

    const named = await this.foreignKeys(queryRunner, sourceTable, spec, spec.constraintName);
    if (named.length > 1) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_NAME_CONFLICT:${spec.constraintName}`);
    }
    if (named.length === 1) {
      this.requireExactForeignKey(named[0], spec, "DEFINITION");
      return;
    }

    const equivalent = await this.foreignKeys(queryRunner, sourceTable, spec);
    if (equivalent.length > 1) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_EQUIVALENT_CONFLICT:${spec.constraintName}`);
    }
    if (equivalent.length === 1) {
      this.requireExactForeignKey(equivalent[0], spec, "EQUIVALENT_DEFINITION");
      return;
    }

    const orphanRows: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM ${quoted(spec.tableName)} source_row
         LEFT JOIN ${quoted(spec.referencedTableName)} target_row
           ON target_row.${quoted(spec.referencedColumnName)} =
              source_row.${quoted(spec.columnName)}
        WHERE source_row.${quoted(spec.columnName)} IS NOT NULL
          AND target_row.${quoted(spec.referencedColumnName)} IS NULL`,
    );
    if (Number(orphanRows[0]?.count ?? 0) !== 0) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_ORPHAN_CONFLICT:${spec.constraintName}`);
    }

    await queryRunner.query(
      `ALTER TABLE ${quoted(spec.tableName)}
         ADD CONSTRAINT ${quoted(spec.constraintName)}
         FOREIGN KEY (${quoted(spec.columnName)})
         REFERENCES ${quoted(spec.referencedTableName)} (${quoted(spec.referencedColumnName)})
         ON UPDATE NO ACTION ON DELETE ${spec.onDelete} NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE ${quoted(spec.tableName)}
         VALIDATE CONSTRAINT ${quoted(spec.constraintName)}`,
    );
  }

  private async foreignKeys(
    queryRunner: QueryRunner,
    sourceTable: string,
    spec: VerifiedLifecycleForeignKey,
    constraintName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return queryRunner.query(
      `SELECT constraint_row.conname, constraint_row.contype,
              constraint_row.convalidated, constraint_row.confdeltype,
              constraint_row.confupdtype, source_column.attname AS source_column,
              constraint_row.confrelid::regclass::text AS referenced_table,
              target_column.attname AS referenced_column
         FROM pg_constraint constraint_row
         JOIN pg_attribute source_column
           ON source_column.attrelid = constraint_row.conrelid
          AND source_column.attnum = constraint_row.conkey[1]
         JOIN pg_attribute target_column
           ON target_column.attrelid = constraint_row.confrelid
          AND target_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = $1::regclass
          AND constraint_row.contype = 'f'
          AND array_length(constraint_row.conkey, 1) = 1
          AND source_column.attname = $2
          AND constraint_row.confrelid = $3::regclass
          AND target_column.attname = $4
          AND ($5::text IS NULL OR constraint_row.conname = $5)`,
      [
        sourceTable,
        spec.columnName,
        `public.${spec.referencedTableName}`,
        spec.referencedColumnName,
        constraintName ?? null,
      ],
    );
  }

  private requireExactForeignKey(
    current: Record<string, unknown>,
    spec: VerifiedLifecycleForeignKey,
    conflict: string,
  ): void {
    if (
      current.contype !== "f"
      || current.convalidated !== true
      || current.confdeltype !== spec.deleteCode
      || current.confupdtype !== "a"
      || current.source_column !== spec.columnName
      || current.referenced_table !== spec.referencedTableName
      || current.referenced_column !== spec.referencedColumnName
    ) {
      throw new Error(`VERIFIED_LIFECYCLE_FK_${conflict}_CONFLICT:${spec.constraintName}`);
    }
  }

  private async requireProjectIdentityColumnTypes(queryRunner: QueryRunner): Promise<void> {
    const expected = new Map([
      ["archived_at", "timestamp with time zone"],
      ["environment_name", "character varying"],
      ["github_repository_id", "character varying"],
      ["owner_user_id", "integer"],
      ["repository_full_name", "character varying"],
      ["target_branch", "character varying"],
    ]);
    const rows: Array<{ column_name: string; column_type: string }> =
      await queryRunner.query(
        `SELECT attribute.attname AS column_name,
                format_type(attribute.atttypid, attribute.atttypmod) AS column_type
           FROM pg_attribute attribute
          WHERE attribute.attrelid = 'public.projects'::regclass
            AND attribute.attname = ANY($1::text[])
            AND NOT attribute.attisdropped
          ORDER BY attribute.attname`,
        [[...expected.keys()]],
      );
    if (
      rows.length !== expected.size
      || rows.some((row) => expected.get(row.column_name) !== row.column_type)
    ) {
      throw new Error("VERIFIED_PROJECT_IDENTITY_COLUMN_TYPE_CONFLICT");
    }
  }

  private async ensureProjectIdentityIndex(
    queryRunner: QueryRunner,
    spec: VerifiedProjectIdentityIndex,
  ): Promise<void> {
    const indexes: CurrentIndex[] = await queryRunner.query(
      `SELECT index_class.relname AS index_name,
              index_row.indisunique, index_row.indisvalid, index_row.indisready,
              access_method.amname AS access_method,
              index_row.indnkeyatts::integer AS key_count,
              ARRAY(
                SELECT pg_get_indexdef(index_row.indexrelid, ordinal, true)
                  FROM generate_series(1, index_row.indnkeyatts) ordinal
              ) AS key_items,
              pg_get_expr(index_row.indpred, index_row.indrelid, true) AS predicate
         FROM pg_index index_row
         JOIN pg_class table_class ON table_class.oid = index_row.indrelid
         JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
         JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
         JOIN pg_am access_method ON access_method.oid = index_class.relam
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname = 'projects'
        ORDER BY index_class.relname`,
    );
    const named = indexes.filter((index) => index.index_name === spec.indexName);
    if (named.length > 1) {
      throw new Error(`VERIFIED_PROJECT_IDENTITY_INDEX_NAME_CONFLICT:${spec.indexName}`);
    }
    if (named.length === 1) {
      this.requireExactIndex(named[0], spec, "DEFINITION");
      return;
    }

    const equivalent = indexes.filter((index) => this.indexMatches(index, spec));
    if (equivalent.length > 1) {
      throw new Error(`VERIFIED_PROJECT_IDENTITY_INDEX_EQUIVALENT_CONFLICT:${spec.indexName}`);
    }
    if (equivalent.length === 1) {
      return;
    }

    const duplicates: Array<{ count: string }> = await queryRunner.query(
      spec.duplicateGroupSql,
    );
    if (Number(duplicates[0]?.count ?? 0) !== 0) {
      throw new Error(`VERIFIED_PROJECT_IDENTITY_DUPLICATE_CONFLICT:${spec.indexName}`);
    }
    await queryRunner.query(spec.createSql);
  }

  private indexMatches(
    current: CurrentIndex,
    spec: VerifiedProjectIdentityIndex,
  ): boolean {
    return current.indisunique === true
      && current.indisvalid === true
      && current.indisready === true
      && current.access_method === "btree"
      && current.key_count === spec.keyItems.length
      && current.key_items.length === spec.keyItems.length
      && current.key_items.every((item, index) => item === spec.keyItems[index])
      && current.predicate === spec.predicate;
  }

  private requireExactIndex(
    current: CurrentIndex,
    spec: VerifiedProjectIdentityIndex,
    conflict: string,
  ): void {
    if (!this.indexMatches(current, spec)) {
      throw new Error(`VERIFIED_PROJECT_IDENTITY_INDEX_${conflict}_CONFLICT:${spec.indexName}`);
    }
  }
}
