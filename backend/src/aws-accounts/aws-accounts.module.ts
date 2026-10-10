import { Module } from "@nestjs/common";
import { AwsAccountsController } from "./aws-accounts.controller";
import { AwsAccountsService } from "./aws-accounts.service";
import { AwsBindingIdentityService } from "./aws-binding-identity.service";

@Module({ controllers: [AwsAccountsController], providers: [AwsAccountsService, AwsBindingIdentityService] })
export class AwsAccountsModule {}
