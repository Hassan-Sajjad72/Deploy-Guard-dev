// ═══════════════════════════════════════════════════
// DeployGuard — Shared Enumerations
// ═══════════════════════════════════════════════════

/** User roles for RBAC enforcement */
export enum UserRole {
  ADMIN = 'admin',
  DEVELOPER = 'developer',
  READONLY = 'readonly',
}

/** Subscription tiers controlling feature access */
export enum SubscriptionTier {
  FREE = 'free',
  PRO = 'pro',
}

/** Project lifecycle states */
export enum ProjectStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

/** Full deployment pipeline state machine */
export enum DeploymentStatus {
  PENDING = 'pending',
  STACK_DETECTION = 'stack_detection',
  BUILDING = 'building',
  SCANNING = 'scanning',
  SCAN_PASSED = 'scan_passed',
  SCAN_FAILED = 'scan_failed',
  COST_ESTIMATING = 'cost_estimating',
  AWAITING_APPROVAL = 'awaiting_approval',
  PROVISIONING = 'provisioning',
  DEPLOYING = 'deploying',
  DEPLOYED = 'deployed',
  FAILED = 'failed',
  ROLLING_BACK = 'rolling_back',
  ROLLED_BACK = 'rolled_back',
  CANCELLED = 'cancelled',
  DESTROYING = 'destroying',
  DESTROYED = 'destroyed',
}

/** Environment targets for variable scoping */
export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

/** Trivy vulnerability severity levels */
export enum VulnerabilitySeverity {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  UNKNOWN = 'UNKNOWN',
}

/** Audit log action categories */
export enum AuditAction {
  // Auth
  USER_LOGIN = 'user.login',
  USER_LOGOUT = 'user.logout',

  // Project
  PROJECT_CREATED = 'project.created',
  PROJECT_UPDATED = 'project.updated',
  PROJECT_DELETED = 'project.deleted',
  PROJECT_ARCHIVED = 'project.archived',

  // Deployment
  DEPLOYMENT_TRIGGERED = 'deployment.triggered',
  DEPLOYMENT_APPROVED = 'deployment.approved',
  DEPLOYMENT_CANCELLED = 'deployment.cancelled',
  DEPLOYMENT_COMPLETED = 'deployment.completed',
  DEPLOYMENT_FAILED = 'deployment.failed',
  DEPLOYMENT_ROLLBACK = 'deployment.rollback',

  // Infrastructure
  INFRA_PROVISIONED = 'infra.provisioned',
  INFRA_DESTROYED = 'infra.destroyed',

  // Security
  SCAN_COMPLETED = 'scan.completed',
  SCAN_BLOCKED = 'scan.blocked',

  // Billing
  SUBSCRIPTION_CHANGED = 'subscription.changed',
}

/** Resource types for audit log references */
export enum ResourceType {
  USER = 'user',
  PROJECT = 'project',
  DEPLOYMENT = 'deployment',
  ENVIRONMENT_VARIABLE = 'environment_variable',
  SUBSCRIPTION = 'subscription',
}

/** Detected framework types from stack detection */
export enum DetectedFramework {
  NEXTJS = 'nextjs',
  REACT = 'react',
  VUE = 'vue',
  ANGULAR = 'angular',
  EXPRESS = 'express',
  NESTJS = 'nestjs',
  FASTAPI = 'fastapi',
  DJANGO = 'django',
  FLASK = 'flask',
  SPRING_BOOT = 'spring_boot',
  GO_GIN = 'go_gin',
  RAILS = 'rails',
  STATIC = 'static',
  UNKNOWN = 'unknown',
}

/** Runtime language detected in the repo */
export enum DetectedRuntime {
  NODEJS = 'nodejs',
  PYTHON = 'python',
  JAVA = 'java',
  GO = 'go',
  RUBY = 'ruby',
  STATIC = 'static',
  UNKNOWN = 'unknown',
}
