import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

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
  @Column({ unique: true, name: "github_id" })
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
   * URL to the user's GitHub avatar image.
   */
  @Column({ nullable: true })
  image: string;

  /**
   * GitHub username (e.g., "johndoe" in github.com/johndoe).
   */
  @Column({ nullable: true, name: "github_login" })
  githubLogin: string;

  /**
   * Timestamp of the most recent login.
   * We update this every time the user signs in.
   */
  @Column({ nullable: true, name: "last_login_at", type: "timestamp" })
  lastLoginAt: Date;

  /**
   * TypeORM auto-sets this when the row is FIRST created.
   * You never set this manually.
   */
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  /**
   * TypeORM auto-updates this whenever the row changes.
   * You never set this manually.
   */
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
