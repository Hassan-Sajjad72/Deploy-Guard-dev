import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

/**
 * UsersModule
 * -----------
 * Groups everything related to users: the entity, service, etc.
 * TypeOrmModule.forFeature([User]) gives this module access to the User repository.
 * We export UsersService so other modules (like AuthModule) can use it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
