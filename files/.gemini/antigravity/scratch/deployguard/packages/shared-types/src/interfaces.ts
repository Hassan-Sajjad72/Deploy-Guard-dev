// ═══════════════════════════════════════════════════
// DeployGuard — Shared Interfaces & DTOs
// ═══════════════════════════════════════════════════

import {
  UserRole,
  SubscriptionTier,
  ProjectStatus,
  DeploymentStatus,
  Environment,
  VulnerabilitySeverity,
  DetectedFramework,
  DetectedRuntime,
  AuditAction,
  ResourceType,
} from './enums';

// ── User ────────────────────────────────────────────

export interface IUser {
  id: string;
  githubId: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  tier: SubscriptionTier;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Project ─────────────────────────────────────────

export interface IProject {
  id: string;
  name: string;
  description: string | null;
  githubRepoUrl: string;
  githubRepoId: string;
  defaultBranch: string;
  selectedBranch: string;
  detectedStack: IDetectedStack | null;
  deploymentProfile: IDeploymentProfile | null;
  status: ProjectStatus;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Deployment ──────────────────────────────────────

export interface IDeployment {
  id: string;
  projectId: string;
  triggeredById: string;
  branch: string;
  commitSha: string;
  status: DeploymentStatus;
  dockerTemplate: string | null;
  dockerfileContent: string | null;
  trivyReport: ITrivyReport | null;
  vulnerabilitySummary: IVulnerabilitySummary | null;
  costEstimate: ICostEstimate | null;
  terraformPlan: string | null;
  ecsTaskArn: string | null;
  ecsServiceArn: string | null;
  albDnsName: string | null;
  healthCheckUrl: string | null;
  buildDurationMs: number | null;
  scanDurationMs: number | null;
  provisionDurationMs: number | null;
  deployDurationMs: number | null;
  failureReason: string | null;
  rollbackFromId: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Audit Log ───────────────────────────────────────

export interface IAuditLog {
  id: string;
  userId: string | null;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// ── Environment Variable ────────────────────────────

export interface IEnvironmentVariable {
  id: string;
  projectId: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  environment: Environment;
  createdAt: Date;
  updatedAt: Date;
}

// ── Stack Detection ─────────────────────────────────

export interface IDetectedStack {
  runtime: DetectedRuntime;
  framework: DetectedFramework;
  runtimeVersion: string | null;
  packageManager: string | null;
  entryPoint: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number;
  hasDockerfile: boolean;
  detectedFiles: string[];
  confidence: number; // 0.0 - 1.0
}

// ── Deployment Profile ──────────────────────────────

export interface IDeploymentProfile {
  stack: IDetectedStack;
  dockerTemplate: string;
  recommendedCpu: number;     // vCPU units (256 = 0.25 vCPU)
  recommendedMemory: number;  // MiB
  healthCheckPath: string;
  exposedPort: number;
  environmentVariables: Record<string, string>;
  estimatedBuildTime: string;
}

// ── Security Scanning ───────────────────────────────

export interface ITrivyVulnerability {
  vulnerabilityId: string;
  pkgName: string;
  installedVersion: string;
  fixedVersion: string | null;
  severity: VulnerabilitySeverity;
  title: string;
  description: string;
  primaryUrl: string | null;
}

export interface ITrivyReport {
  schemaVersion: number;
  results: Array<{
    target: string;
    class: string;
    type: string;
    vulnerabilities: ITrivyVulnerability[];
  }>;
}

export interface IVulnerabilitySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
  passed: boolean;
  blockedBy: VulnerabilitySeverity | null;
}

// ── Cost Estimation ─────────────────────────────────

export interface ICostBreakdown {
  resourceName: string;
  resourceType: string;
  monthlyCost: number;
  hourlyCost: number;
}

export interface ICostEstimate {
  totalMonthlyCost: number;
  totalHourlyCost: number;
  currency: string;
  breakdown: ICostBreakdown[];
  generatedAt: Date;
}

// ── API Response Wrappers ───────────────────────────

export interface IApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
}

export interface IApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  timestamp: string;
}

export interface IPaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  timestamp: string;
}

// ── Pipeline Job ────────────────────────────────────

export interface IPipelineJobData {
  deploymentId: string;
  projectId: string;
  userId: string;
  branch: string;
  commitSha: string;
}

export interface IPipelineStepResult {
  step: string;
  success: boolean;
  durationMs: number;
  error?: string;
  data?: Record<string, unknown>;
}
