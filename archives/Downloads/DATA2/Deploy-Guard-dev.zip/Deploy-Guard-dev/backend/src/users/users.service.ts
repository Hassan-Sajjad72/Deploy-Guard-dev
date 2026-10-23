import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "./user.entity";

/**
 * UsersService
 * ------------
 * This is where ALL database operations for users live.
 * Think of it as the "manager" that talks to PostgreSQL.
 *
 * It uses TypeORM's Repository pattern:
 * - Repository = a helper object that knows how to do SQL queries on one table
 * - @InjectRepository(User) = NestJS gives us the User repository automatically
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {}

  /**
   * findOrCreate
   * ------------
   * The core logic: "Does this GitHub user already exist in our DB?"
   * - YES → update their info (in case they changed name/avatar) and return them
   * - NO  → create a new row and return it
   *
   * This is called every time someone signs in with GitHub.
   */
  async findOrCreate(githubData: {
    githubId: string;
    name: string;
    email: string;
    image: string;
    login: string;
  }): Promise<{ user: User; isNewUser: boolean }> {
    // Step 1: Search PostgreSQL for a row with this github_id
    // SQL equivalent: SELECT * FROM users WHERE github_id = $1 LIMIT 1
    let user = await this.userRepository.findOne({
      where: { githubId: githubData.githubId },
    });

    let isNewUser = false;

    if (!user) {
      // Step 2a: User NOT found — create a new row
      // SQL equivalent: INSERT INTO users (github_id, name, email, ...) VALUES (...)
      isNewUser = true;
      user = this.userRepository.create({
        githubId: githubData.githubId,
        name: githubData.name,
        email: githubData.email,
        image: githubData.image,
        githubLogin: githubData.login,
        lastLoginAt: new Date(),
      });
    } else {
      // Step 2b: User FOUND — update their info (profile may have changed)
      user.name = githubData.name;
      user.email = githubData.email;
      user.image = githubData.image;
      user.githubLogin = githubData.login;
      user.lastLoginAt = new Date();
    }

    // Step 3: Save to PostgreSQL (INSERT or UPDATE depending on case above)
    // SQL equivalent: either INSERT or UPDATE ... WHERE id = $1
    const savedUser = await this.userRepository.save(user);

    return { user: savedUser, isNewUser };
  }

  /**
   * findById
   * --------
   * Get one user by their internal database ID.
   * SQL equivalent: SELECT * FROM users WHERE id = $1
   */
  async findById(id: number): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  /**
   * findAll
   * -------
   * Get all users (useful for admin views).
   * SQL equivalent: SELECT * FROM users ORDER BY created_at DESC
   */
  async findAll(): Promise<User[]> {
    return this.userRepository.find({
      order: { createdAt: "DESC" },
    });
  }
}
