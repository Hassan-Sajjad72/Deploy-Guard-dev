import { createCipheriv, createHash, randomBytes } from "crypto";
import { MigrationInterface, QueryRunner } from "typeorm";

export class EncryptLegacyProjectEnvironmentValues1760000020000 implements MigrationInterface {
  name = "EncryptLegacyProjectEnvironmentValues1760000020000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const secret = process.env.AUTH_SESSION_SECRET?.trim();
    if (!secret || secret.length < 32) {
      throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters before environment values can be encrypted");
    }
    const key = createHash("sha256").update(`deployguard-project-environment:${secret}`).digest();
    const rows = await queryRunner.query(
      `SELECT "id", "value" FROM "project_environment_variables" WHERE "encryption_version" = 0`
    ) as Array<{ id: string; value: string }>;
    for (const row of rows) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(row.value, "utf8"), cipher.final()]);
      const protectedValue = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
      await queryRunner.query(
        `UPDATE "project_environment_variables" SET "value" = $1, "encryption_version" = 1 WHERE "id" = $2`,
        [protectedValue, row.id]
      );
    }
  }

  async down(): Promise<void> {
    throw new Error("Encrypted environment values cannot be safely downgraded to plaintext");
  }
}
