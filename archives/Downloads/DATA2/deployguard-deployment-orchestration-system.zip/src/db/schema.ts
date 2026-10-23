import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

// Enums
export const roleEnum = pgEnum("role", ["admin", "developer", "readonly"]);
export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "building",
  "scanning",
  "provisioning",
  "deploying",
  "deployed",
  "failed",
  "rolled_back",
  "destroying",
  "destroyed",
]);
export const severityEnum = pgEnum("severity", ["critical", "high", "medium", "low"]);
export const subscriptionTierEnum = pgEnum("subscription_tier", ["free", "pro"]);

// Users
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  avatarUrl: text("avatar_url"),
  githubUsername: varchar("github_username", { length: 255 }),
  role: roleEnum("role").default("developer").notNull(),
  subscriptionTier: subscriptionTierEnum("subscription_tier").default("free").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Projects
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  repositoryUrl: varchar("repository_url", { length: 500 }).notNull(),
  branch: varchar("branch", { length: 255 }).default("main"),
  detectedStack: jsonb("detected_stack"),
  environmentVars: jsonb("environment_vars"),
  status: varchar("status", { length: 50 }).default("active"),
  awsRegion: varchar("aws_region", { length: 50 }).default("us-east-1"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Deployments
export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  commitHash: varchar("commit_hash", { length: 40 }),
  commitMessage: text("commit_message"),
  status: deploymentStatusEnum("status").default("queued").notNull(),
  dockerImageUrl: text("docker_image_url"),
  terraformPlanUrl: text("terraform_plan_url"),
  buildDuration: integer("build_duration"),
  scanDuration: integer("scan_duration"),
  deployDuration: integer("deploy_duration"),
  estimatedCost: varchar("estimated_cost", { length: 50 }),
  actualCost: varchar("actual_cost", { length: 50 }),
  failureReason: text("failure_reason"),
  logs: text("logs"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

// Vulnerability Scans
export const vulnerabilityScans = pgTable("vulnerability_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id").references(() => deployments.id).notNull(),
  totalVulnerabilities: integer("total_vulnerabilities").default(0),
  criticalCount: integer("critical_count").default(0),
  highCount: integer("high_count").default(0),
  mediumCount: integer("medium_count").default(0),
  lowCount: integer("low_count").default(0),
  scanPassed: boolean("scan_passed").default(false),
  rawResults: jsonb("raw_results"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Vulnerability Details
export const vulnerabilities = pgTable("vulnerabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id").references(() => vulnerabilityScans.id).notNull(),
  cveId: varchar("cve_id", { length: 50 }).notNull(),
  severity: severityEnum("severity").notNull(),
  packageName: varchar("package_name", { length: 255 }).notNull(),
  installedVersion: varchar("installed_version", { length: 100 }),
  fixedVersion: varchar("fixed_version", { length: 100 }),
  description: text("description"),
  remediation: text("remediation"),
});

// Cost Estimates
export const costEstimates = pgTable("cost_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id").references(() => deployments.id).notNull(),
  totalMonthlyCost: varchar("total_monthly_cost", { length: 50 }),
  currency: varchar("currency", { length: 10 }).default("USD"),
  costBreakdown: jsonb("cost_breakdown"),
  approvedByUser: boolean("approved_by_user").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Audit Logs
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 255 }).notNull(),
  resource: varchar("resource", { length: 255 }),
  resourceId: uuid("resource_id"),
  details: jsonb("details"),
  ipAddress: varchar("ip_address", { length: 45 }),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

// Chat Conversations
export const chatConversations = pgTable("chat_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  deploymentId: uuid("deployment_id").references(() => deployments.id),
  title: varchar("title", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Chat Messages
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => chatConversations.id).notNull(),
  role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  logContext: text("log_context"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Notifications
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  type: varchar("type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  read: boolean("read").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Subscriptions
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  tier: subscriptionTierEnum("tier").default("free").notNull(),
  maxProjects: integer("max_projects").default(3),
  currentProjects: integer("current_projects").default(0),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
