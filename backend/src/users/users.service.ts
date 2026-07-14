import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { User, UserRole } from "./user.entity";

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
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService
  ) {}

  async storeGithubAccessToken(userId: number, accessToken: string): Promise<void> {
    await this.userRepository.update(userId, {
      githubAccessToken: this.encrypt(accessToken),
    });
  }

  async getGithubAccessToken(userId: number): Promise<string | null> {
    const user = await this.userRepository
      .createQueryBuilder("user")
      .addSelect("user.githubAccessToken")
      .where("user.id = :userId", { userId })
      .getOne();
    if (!user?.githubAccessToken) return null;
    try {
      return this.decrypt(user.githubAccessToken);
    } catch {
      return null;
    }
  }

  private encryptionKey(): Buffer {
    const secret = this.configService.get<string>("AUTH_SESSION_SECRET")?.trim();
    if (!secret || secret.length < 32) throw new Error("AUTH_SESSION_SECRET is required to protect GitHub credentials");
    return createHash("sha256").update(secret).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decrypt(value: string): string {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted credential");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }

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

    if (!user && githubData.email) {
      user = await this.findByEmail(githubData.email);
    }

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
      user.githubId = githubData.githubId;
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

  async createWithPassword(data: {
    name: string;
    email: string;
    passwordHash: string;
  }): Promise<User> {
    const existingUser = await this.findByEmail(data.email);

    if (existingUser) {
      throw new ConflictException("Email is already registered");
    }

    const user = this.userRepository.create({
      name: data.name,
      email: data.email,
      passwordHash: data.passwordHash,
      lastLoginAt: new Date(),
    });

    return this.userRepository.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("LOWER(user.email) = LOWER(:email)", { email })
      .getOne();
  }

  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder("user")
      .addSelect("user.passwordHash")
      .where("LOWER(user.email) = LOWER(:email)", { email })
      .getOne();
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

  /**
   * updateRole
   * ----------
   * Admin-only user management calls this to change a user's RBAC role.
   */
  async updateRole(id: number, role: UserRole, actorUserId?: number): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (
      actorUserId === user.id &&
      user.role === UserRole.ADMIN &&
      role !== UserRole.ADMIN
    ) {
      throw new BadRequestException("Administrators cannot remove their own admin access");
    }

    if (user.role === UserRole.ADMIN && role !== UserRole.ADMIN) {
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN },
      });
      if (adminCount <= 1) {
        throw new BadRequestException("The last administrator cannot be demoted");
      }
    }

    user.role = role;

    return this.userRepository.save(user);
  }

  async markLoggedIn(user: User): Promise<User> {
    user.lastLoginAt = new Date();

    return this.userRepository.save(user);
  }
}
