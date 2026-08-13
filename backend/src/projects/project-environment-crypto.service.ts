import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

@Injectable()
export class ProjectEnvironmentCryptoService {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  decrypt(value: string) {
    if (!this.isEncrypted(value)) return value;
    const [, iv, tag, encrypted] = value.split(".");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  isEncrypted(value: string) {
    return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  }

  private key() {
    const secret = this.config.get<string>("AUTH_SESSION_SECRET")?.trim();
    if (!secret || secret.length < 32) {
      throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters to protect project environment variables");
    }
    return createHash("sha256").update(`deployguard-project-environment:${secret}`).digest();
  }
}
