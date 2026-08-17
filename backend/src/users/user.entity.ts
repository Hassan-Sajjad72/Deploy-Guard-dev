import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum UserRole {
  ADMIN = "admin",
  DEVELOPER = "developer",
  READONLY = "readonly",
}

/**
 * User Entity
 * -----------
 * This class DEFINES what the "users" table looks like in PostgreSQL.
 * TypeORM reads this class and automatically creates the table.
 *
 * Each @Column() decorator = one column in the database table.
 * The table will have these columns:
 * id, github_id, name, email, image, github_login, last_login_at, created_at, updated_at
 */
@Entity("users") // Table name in PostgreSQL
@Check("CHK_users_admin_not_github", `"github_id" IS NULL OR "role" <> 'admin'`)
export class User {
  /**
   * Auto-incrementing primary key.
   * PostgreSQL assigns this: 1, 2, 3, 4...
   */
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * GitHub's own ID for this user.
   * This is how we identify if a user already exists.
   * @Index makes searching by github_id FAST.
   * unique: true = no two rows can have the same github_id.
   */
  @Index()
  @Column({ unique: true, nullable: true, name: "github_id" })
  githubId: string;

  /**
   * User's display name from GitHub profile.
   * nullable: true = allowed to be empty (some GitHub accounts have no name).
   */
  @Column({ nullable: true })
  name: string;

  /**
   * User's email from GitHub.
   * May be null if the GitHub user keeps email private.
   */
  @Column({ nullable: true })
  email: string;

  /**
   * Password hash for standard email/password accounts.
   * select: false keeps it out of normal user queries and API responses.
   */
  @Column({ nullable: true, name: "password_hash", select: false })
  passwordHash: string;

  /**
   * URL to the user's GitHub avatar image.
   */
  @Column({ nullable: true })
  image: string;

  /**
   * GitHub username (e.g., "johndoe" in github.com/johndoe).
   */
  @Column({ nullable: true, name: "github_login" })
  githubLogin: string;

  /** Encrypted at rest and excluded from normal queries/API serialization. */
  @Column({ nullable: true, name: "github_access_token", type: "text", select: false })
  githubAccessToken: string;

  /**
   * Timestamp of the most recent login.
   * We update this every time the user signs in.
   */
  @Column({ nullable: true, name: "last_login_at", type: "timestamptz" })
  lastLoginAt: Date;

  /** Disabled accounts retain their audit history but cannot authenticate. */
  @Column({ nullable: true, name: "disabled_at", type: "timestamptz" })
  disabledAt: Date | null;

  /**
   * Role used by RBAC-protected API routes.
   */
  @Column({
    type: "enum",
    enum: UserRole,
    default: UserRole.DEVELOPER,
  })
  role: UserRole;

  /**
   * TypeORM auto-sets this when the row is FIRST created.
   * You never set this manually.
   */
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  /**
   * TypeORM auto-updates this whenever the row changes.
   * You never set this manually.
   */
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
