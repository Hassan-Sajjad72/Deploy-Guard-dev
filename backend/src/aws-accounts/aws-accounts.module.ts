import { Module } from "@nestjs/common";
import { AwsAccountsController } from "./aws-accounts.controller";
import { AwsAccountsService } from "./aws-accounts.service";

@Module({ controllers: [AwsAccountsController], providers: [AwsAccountsService] })
export class AwsAccountsModule {}
