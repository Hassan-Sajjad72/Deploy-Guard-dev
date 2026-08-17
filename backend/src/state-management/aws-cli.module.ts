import { Module } from "@nestjs/common";
import { AwsCliService } from "./aws-cli.service";

/** Read-only AWS inspection boundary used by the active GitHub Actions lane. */
@Module({
  providers: [AwsCliService],
  exports: [AwsCliService],
})
export class AwsCliModule {}
