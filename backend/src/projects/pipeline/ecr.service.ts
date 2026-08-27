import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CreateRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  PutLifecyclePolicyCommand,
  TagResourceCommand,
} from "@aws-sdk/client-ecr";
import { spawn } from "child_process";

const LIFECYCLE_POLICY = {
  rules: [
    {
      rulePriority: 1,
      description: "Expire untagged images older than 30 days",
      selection: {
        tagStatus: "untagged",
        countType: "sinceImagePushed",
        countUnit: "days",
        countNumber: 30,
      },
      action: {
        type: "expire",
      },
    },
  ],
};

@Injectable()
export class EcrService {
  constructor(private readonly config: ConfigService) {}

  hasConfig() {
    return Boolean(
      this.config.get<string>("AWS_REGION") &&
        this.config.get<string>("AWS_ACCOUNT_ID") &&
        this.config.get<string>("AWS_ACCESS_KEY_ID") &&
        this.config.get<string>("AWS_SECRET_ACCESS_KEY")
    );
  }

  getRepositoryName(projectName: string, projectId?: string) {
    const prefix = this.config.get<string>("ECR_REPOSITORY_PREFIX", "mini-paas");
    const projectSuffix = projectId ? `-${this.safeName(projectId).slice(0, 16)}` : "";
    return `${this.safeName(prefix)}-${this.safeName(projectName)}${projectSuffix}`.slice(0, 128).replace(/-+$/g, "");
  }

  getImageUri(repositoryName: string, imageTag: string) {
    const accountId = this.config.get<string>("AWS_ACCOUNT_ID");
    const region = this.config.get<string>("AWS_REGION", "us-east-1");
    return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:${imageTag}`;
  }

  async ensureRepository(repositoryName: string, tags: Record<string, string>) {
    const client = this.createClient();
    const repositoryTags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    try {
      const existing = await client.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
      const repositoryArn = existing.repositories?.[0]?.repositoryArn;
      if (repositoryArn) await client.send(new TagResourceCommand({ resourceArn: repositoryArn, tags: repositoryTags }));
      return { repositoryArn: repositoryArn || null, repositoryName, created: false };
    } catch {
      const created = await client.send(new CreateRepositoryCommand({ repositoryName, tags: repositoryTags }));
      return { repositoryArn: created.repository?.repositoryArn || null, repositoryName, created: true };
    }
  }

  async loginDocker() {
    const client = this.createClient();
    const response = await client.send(new GetAuthorizationTokenCommand({}));
    const auth = response.authorizationData?.[0];

    if (!auth?.authorizationToken || !auth.proxyEndpoint) {
      throw new Error("Unable to obtain ECR authorization token");
    }

    const decoded = Buffer.from(auth.authorizationToken, "base64").toString("utf8");
    const [username, password] = decoded.split(":");

    if (!username || !password) {
      throw new Error("Invalid ECR authorization token");
    }

    await this.dockerLogin(auth.proxyEndpoint, username, password);
  }

  async applyLifecyclePolicy(repositoryName: string) {
    const client = this.createClient();
    await client.send(
      new PutLifecyclePolicyCommand({
        repositoryName,
        lifecyclePolicyText: JSON.stringify(LIFECYCLE_POLICY),
      })
    );
  }

  async getImageDigest(repositoryName: string, imageTag: string) {
    const response = await this.createClient().send(new DescribeImagesCommand({
      repositoryName,
      imageIds: [{ imageTag }],
    }));
    return response.imageDetails?.[0]?.imageDigest || null;
  }

  private createClient() {
    return new ECRClient({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
      credentials: {
        accessKeyId: this.config.get<string>("AWS_ACCESS_KEY_ID", ""),
        secretAccessKey: this.config.get<string>("AWS_SECRET_ACCESS_KEY", ""),
      },
    });
  }

  private dockerLogin(registry: string, username: string, password: string) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["login", "--username", username, "--password-stdin", registry], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || "Docker login to ECR failed"));
        }
      });
      child.stdin.write(password);
      child.stdin.end();
    });
  }

  private safeName(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }
}
