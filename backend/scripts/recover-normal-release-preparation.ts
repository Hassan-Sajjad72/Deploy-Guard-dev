import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { NormalReleaseLanePreMutationRecoveryService } from "../src/orchestration-contracts/release-lane/normal-release-lane-pre-mutation-recovery.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const projectId = process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST;
  const failedIntentId = process.env.TWO_LANE_NORMAL_RELEASE_RECOVERY_FAILED_INTENT_ID;
  if (process.env.TWO_LANE_NORMAL_RELEASE_RECOVERY_APPROVED !== "true"
    || !UUID.test(projectId ?? "") || !UUID.test(failedIntentId ?? "")) {
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["NORMAL_RELEASE_RECOVERY_NOT_APPROVED"] })}\n`);
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  try {
    const dataSource = app.get(DataSource);
    const users = await dataSource.query(
      `SELECT owner_user_id AS "id" FROM projects WHERE id = $1`, [projectId],
    ) as Array<{ id: number }>;
    if (users.length !== 1 || !Number.isInteger(users[0].id)) {
      process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["NORMAL_RELEASE_RECOVERY_ACTOR_UNAVAILABLE"] })}\n`);
      return;
    }
    const result = await app.get(NormalReleaseLanePreMutationRecoveryService).recover(
      { id: users[0].id, role: "developer" } as any,
      projectId!,
      failedIntentId!,
    );
    process.stdout.write(`${JSON.stringify({ state: result.state, safeCodes: result.safeCodes })}\n`);
  } finally {
    await app.close();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["NORMAL_RELEASE_RECOVERY_FAILED"] })}\n`);
  process.exitCode = 2;
});
