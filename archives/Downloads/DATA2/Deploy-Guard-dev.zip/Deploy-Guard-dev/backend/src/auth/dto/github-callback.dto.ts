import { IsString, IsEmail, IsOptional, IsNotEmpty } from "class-validator";

/**
 * GitHubCallbackDto
 * -----------------
 * DTO = Data Transfer Object.
 * This defines the EXACT shape of data we expect from the frontend
 * when a user signs in with GitHub.
 *
 * class-validator decorators automatically reject invalid data:
 * - @IsString() → must be a string
 * - @IsNotEmpty() → cannot be empty
 * - @IsOptional() → field is not required
 *
 * If the frontend sends wrong data, NestJS returns 400 Bad Request automatically.
 */
export class GitHubCallbackDto {
  @IsString()
  @IsNotEmpty()
  githubId: string; // GitHub's unique ID for this user

  @IsString()
  @IsOptional()
  name?: string; // Display name (may be null)

  @IsEmail()
  @IsOptional()
  email?: string; // Email (may be private)

  @IsString()
  @IsOptional()
  image?: string; // Avatar URL

  @IsString()
  @IsOptional()
  login?: string; // GitHub username

  @IsString()
  @IsOptional()
  accessToken?: string; // GitHub access token (we store/use if needed)
}
