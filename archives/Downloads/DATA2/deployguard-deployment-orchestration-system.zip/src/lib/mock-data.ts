export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
  branch: string;
  detectedStack: {
    language: string;
    framework: string;
    runtime: string;
    packageManager: string;
    buildCommand: string;
    port: number;
  };
  status: "active" | "deploying" | "failed" | "idle";
  awsRegion: string;
  lastDeployed: string;
  createdAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  commitHash: string;
  commitMessage: string;
  status: "queued" | "building" | "scanning" | "provisioning" | "deploying" | "deployed" | "failed" | "rolled_back";
  buildDuration: number;
  scanDuration: number;
  deployDuration: number;
  estimatedCost: string;
  createdAt: string;
  completedAt: string;
}

export interface Vulnerability {
  id: string;
  cveId: string;
  severity: "critical" | "high" | "medium" | "low";
  packageName: string;
  installedVersion: string;
  fixedVersion: string;
  description: string;
  remediation: string;
}

export interface CostBreakdown {
  resource: string;
  monthlyCost: number;
  unit: string;
}

export interface AuditLog {
  id: string;
  action: string;
  resource: string;
  user: string;
  timestamp: string;
  details: string;
  severity: "info" | "warning" | "error" | "success";
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  timestamp: string;
  projectId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============ MOCK DATA ============

export const mockProjects: Project[] = [
  {
    id: "proj-001",
    name: "E-Commerce Platform",
    repositoryUrl: "https://github.com/acme/ecommerce-platform",
    branch: "main",
    detectedStack: {
      language: "Node.js",
      framework: "Next.js 14",
      runtime: "node:20-alpine",
      packageManager: "npm",
      buildCommand: "npm run build",
      port: 3000,
    },
    status: "active",
    awsRegion: "us-east-1",
    lastDeployed: "2026-02-25T14:30:00Z",
    createdAt: "2026-01-15T09:00:00Z",
  },
  {
    id: "proj-002",
    name: "Analytics Dashboard",
    repositoryUrl: "https://github.com/acme/analytics-dashboard",
    branch: "production",
    detectedStack: {
      language: "Python",
      framework: "FastAPI",
      runtime: "python:3.12-slim",
      packageManager: "pip",
      buildCommand: "pip install -r requirements.txt",
      port: 8000,
    },
    status: "deploying",
    awsRegion: "us-west-2",
    lastDeployed: "2026-02-26T10:15:00Z",
    createdAt: "2026-02-01T11:00:00Z",
  },
  {
    id: "proj-003",
    name: "Auth Microservice",
    repositoryUrl: "https://github.com/acme/auth-service",
    branch: "main",
    detectedStack: {
      language: "Node.js",
      framework: "Express.js",
      runtime: "node:20-alpine",
      packageManager: "npm",
      buildCommand: "npm run build",
      port: 4000,
    },
    status: "failed",
    awsRegion: "eu-west-1",
    lastDeployed: "2026-02-24T08:45:00Z",
    createdAt: "2026-01-20T14:00:00Z",
  },
  {
    id: "proj-004",
    name: "ML Pipeline API",
    repositoryUrl: "https://github.com/acme/ml-pipeline",
    branch: "staging",
    detectedStack: {
      language: "Python",
      framework: "Django 5",
      runtime: "python:3.12-slim",
      packageManager: "pip",
      buildCommand: "python manage.py collectstatic",
      port: 8000,
    },
    status: "idle",
    awsRegion: "us-east-1",
    lastDeployed: "2026-02-20T16:00:00Z",
    createdAt: "2026-02-10T10:00:00Z",
  },
  {
    id: "proj-005",
    name: "Customer Portal",
    repositoryUrl: "https://github.com/acme/customer-portal",
    branch: "main",
    detectedStack: {
      language: "Node.js",
      framework: "Next.js 14",
      runtime: "node:20-alpine",
      packageManager: "npm",
      buildCommand: "npm run build",
      port: 3000,
    },
    status: "active",
    awsRegion: "ap-southeast-1",
    lastDeployed: "2026-02-26T09:00:00Z",
    createdAt: "2026-02-05T13:00:00Z",
  },
];

export const mockDeployments: Deployment[] = [
  {
    id: "dep-001",
    projectId: "proj-001",
    commitHash: "a3f8b2c",
    commitMessage: "feat: add payment gateway integration",
    status: "deployed",
    buildDuration: 145,
    scanDuration: 32,
    deployDuration: 210,
    estimatedCost: "$47.20/mo",
    createdAt: "2026-02-25T14:00:00Z",
    completedAt: "2026-02-25T14:08:27Z",
  },
  {
    id: "dep-002",
    projectId: "proj-002",
    commitHash: "e7d1a9f",
    commitMessage: "fix: resolve dashboard chart rendering",
    status: "deploying",
    buildDuration: 98,
    scanDuration: 28,
    deployDuration: 0,
    estimatedCost: "$32.50/mo",
    createdAt: "2026-02-26T10:15:00Z",
    completedAt: "",
  },
  {
    id: "dep-003",
    projectId: "proj-003",
    commitHash: "b2c4e8a",
    commitMessage: "chore: update dependencies",
    status: "failed",
    buildDuration: 67,
    scanDuration: 45,
    deployDuration: 0,
    estimatedCost: "$28.00/mo",
    createdAt: "2026-02-24T08:30:00Z",
    completedAt: "",
  },
  {
    id: "dep-004",
    projectId: "proj-001",
    commitHash: "f1a3d7e",
    commitMessage: "fix: cart calculation edge case",
    status: "deployed",
    buildDuration: 120,
    scanDuration: 30,
    deployDuration: 195,
    estimatedCost: "$47.20/mo",
    createdAt: "2026-02-23T16:00:00Z",
    completedAt: "2026-02-23T16:07:45Z",
  },
  {
    id: "dep-005",
    projectId: "proj-004",
    commitHash: "c9e2b5d",
    commitMessage: "feat: add model training endpoint",
    status: "deployed",
    buildDuration: 180,
    scanDuration: 52,
    deployDuration: 240,
    estimatedCost: "$62.80/mo",
    createdAt: "2026-02-20T15:30:00Z",
    completedAt: "2026-02-20T15:41:12Z",
  },
  {
    id: "dep-006",
    projectId: "proj-005",
    commitHash: "d4f6a1c",
    commitMessage: "feat: customer feedback module",
    status: "deployed",
    buildDuration: 135,
    scanDuration: 35,
    deployDuration: 200,
    estimatedCost: "$39.90/mo",
    createdAt: "2026-02-26T08:45:00Z",
    completedAt: "2026-02-26T08:54:15Z",
  },
];

export const mockVulnerabilities: Vulnerability[] = [
  {
    id: "vuln-001",
    cveId: "CVE-2026-1234",
    severity: "critical",
    packageName: "lodash",
    installedVersion: "4.17.20",
    fixedVersion: "4.17.21",
    description: "Prototype pollution in lodash allows attackers to modify the prototype of Object when properties are added using __proto__.",
    remediation: "npm update lodash@4.17.21",
  },
  {
    id: "vuln-002",
    cveId: "CVE-2026-2345",
    severity: "high",
    packageName: "axios",
    installedVersion: "1.6.0",
    fixedVersion: "1.7.0",
    description: "Server-Side Request Forgery in axios allows attackers to bypass access controls via crafted requests.",
    remediation: "npm update axios@1.7.0",
  },
  {
    id: "vuln-003",
    cveId: "CVE-2026-3456",
    severity: "high",
    packageName: "jsonwebtoken",
    installedVersion: "9.0.1",
    fixedVersion: "9.0.2",
    description: "Insecure default algorithm in jsonwebtoken allows token forgery.",
    remediation: "npm update jsonwebtoken@9.0.2",
  },
  {
    id: "vuln-004",
    cveId: "CVE-2026-4567",
    severity: "medium",
    packageName: "express",
    installedVersion: "4.18.2",
    fixedVersion: "4.19.0",
    description: "Open redirect vulnerability in express allows phishing attacks via crafted URLs.",
    remediation: "npm update express@4.19.0",
  },
  {
    id: "vuln-005",
    cveId: "CVE-2026-5678",
    severity: "medium",
    packageName: "cookie-parser",
    installedVersion: "1.4.6",
    fixedVersion: "1.4.7",
    description: "ReDoS vulnerability in cookie parsing logic.",
    remediation: "npm update cookie-parser@1.4.7",
  },
  {
    id: "vuln-006",
    cveId: "CVE-2026-6789",
    severity: "low",
    packageName: "cors",
    installedVersion: "2.8.5",
    fixedVersion: "2.8.6",
    description: "Improper CORS validation under specific configurations.",
    remediation: "npm update cors@2.8.6",
  },
  {
    id: "vuln-007",
    cveId: "CVE-2026-7890",
    severity: "critical",
    packageName: "node-fetch",
    installedVersion: "2.6.0",
    fixedVersion: "2.7.0",
    description: "Information exposure through error messages in node-fetch.",
    remediation: "npm update node-fetch@2.7.0",
  },
  {
    id: "vuln-008",
    cveId: "CVE-2026-8901",
    severity: "low",
    packageName: "morgan",
    installedVersion: "1.10.0",
    fixedVersion: "1.10.1",
    description: "Log injection vulnerability in morgan logger.",
    remediation: "npm update morgan@1.10.1",
  },
];

export const mockCostBreakdown: CostBreakdown[] = [
  { resource: "ECS Fargate (2 tasks)", monthlyCost: 28.60, unit: "USD" },
  { resource: "Application Load Balancer", monthlyCost: 16.20, unit: "USD" },
  { resource: "NAT Gateway", monthlyCost: 32.40, unit: "USD" },
  { resource: "CloudWatch Logs", monthlyCost: 3.50, unit: "USD" },
  { resource: "EFS Storage (10 GB)", monthlyCost: 3.00, unit: "USD" },
  { resource: "Data Transfer (5 GB)", monthlyCost: 0.45, unit: "USD" },
  { resource: "ECR Storage", monthlyCost: 0.10, unit: "USD" },
  { resource: "S3 State Storage", monthlyCost: 0.05, unit: "USD" },
];

export const mockAuditLogs: AuditLog[] = [
  {
    id: "log-001",
    action: "Deployment Initiated",
    resource: "E-Commerce Platform",
    user: "Hassan Sajjad",
    timestamp: "2026-02-26T14:30:00Z",
    details: "Deploy commit a3f8b2c to us-east-1",
    severity: "info",
  },
  {
    id: "log-002",
    action: "Security Scan Failed",
    resource: "Auth Microservice",
    user: "System",
    timestamp: "2026-02-26T14:25:00Z",
    details: "2 critical vulnerabilities detected - deployment blocked",
    severity: "error",
  },
  {
    id: "log-003",
    action: "Cost Approval Required",
    resource: "ML Pipeline API",
    user: "System",
    timestamp: "2026-02-26T13:00:00Z",
    details: "Estimated cost $62.80/mo exceeds warning threshold of $50.00/mo",
    severity: "warning",
  },
  {
    id: "log-004",
    action: "Deployment Succeeded",
    resource: "Customer Portal",
    user: "Faria Fatima",
    timestamp: "2026-02-26T09:00:00Z",
    details: "Deploy commit d4f6a1c to ap-southeast-1",
    severity: "success",
  },
  {
    id: "log-005",
    action: "Infrastructure Destroyed",
    resource: "Test Environment",
    user: "Tania Khawar",
    timestamp: "2026-02-25T18:00:00Z",
    details: "terraform destroy executed - all resources removed",
    severity: "warning",
  },
  {
    id: "log-006",
    action: "User Login",
    resource: "Auth System",
    user: "Hassan Sajjad",
    timestamp: "2026-02-26T08:00:00Z",
    details: "Login via GitHub OAuth",
    severity: "info",
  },
  {
    id: "log-007",
    action: "State Lock Acquired",
    resource: "E-Commerce Platform",
    user: "System",
    timestamp: "2026-02-26T14:30:01Z",
    details: "DynamoDB lock acquired for proj-001 deployment",
    severity: "info",
  },
  {
    id: "log-008",
    action: "Rollback Executed",
    resource: "Auth Microservice",
    user: "System",
    timestamp: "2026-02-24T09:15:00Z",
    details: "Automatic rollback to commit f1a3d7e after health check failure",
    severity: "error",
  },
  {
    id: "log-009",
    action: "Terraform Export",
    resource: "E-Commerce Platform",
    user: "Hassan Sajjad",
    timestamp: "2026-02-25T16:00:00Z",
    details: "User downloaded .zip archive of Terraform scripts",
    severity: "info",
  },
  {
    id: "log-010",
    action: "Subscription Upgraded",
    resource: "Billing",
    user: "Faria Fatima",
    timestamp: "2026-02-20T10:00:00Z",
    details: "Upgraded from Free to Pro plan",
    severity: "success",
  },
];

export const mockNotifications: Notification[] = [
  {
    id: "notif-001",
    type: "deployment",
    title: "Deployment Successful",
    message: "E-Commerce Platform deployed successfully to us-east-1",
    read: false,
    timestamp: "2026-02-26T14:30:00Z",
    projectId: "proj-001",
  },
  {
    id: "notif-002",
    type: "security",
    title: "Security Scan Blocked",
    message: "Auth Microservice deployment blocked: 2 critical vulnerabilities found",
    read: false,
    timestamp: "2026-02-26T14:25:00Z",
    projectId: "proj-003",
  },
  {
    id: "notif-003",
    type: "cost",
    title: "Cost Threshold Warning",
    message: "ML Pipeline API estimated cost ($62.80/mo) exceeds your warning threshold",
    read: true,
    timestamp: "2026-02-26T13:00:00Z",
    projectId: "proj-004",
  },
  {
    id: "notif-004",
    type: "infrastructure",
    title: "Spot Interruption Notice",
    message: "AWS EventBridge: Fargate Spot task for Analytics Dashboard will be interrupted in 2 minutes",
    read: false,
    timestamp: "2026-02-26T11:00:00Z",
    projectId: "proj-002",
  },
  {
    id: "notif-005",
    type: "rollback",
    title: "Auto-Rollback Triggered",
    message: "Auth Microservice health check failed - rolling back to previous stable commit",
    read: true,
    timestamp: "2026-02-24T09:15:00Z",
    projectId: "proj-003",
  },
];

export const mockChatHistory: ChatMessage[] = [
  {
    id: "msg-001",
    role: "user",
    content: "My Auth Microservice deployment failed. Can you help me understand what went wrong?",
    timestamp: "2026-02-26T14:40:00Z",
  },
  {
    id: "msg-002",
    role: "assistant",
    content: `## Deployment Failure Analysis — Auth Microservice

**Root Cause:** Aqua Trivy security scan detected 2 critical vulnerabilities that violated the deployment security policy.

### Vulnerabilities Found:

1. **CVE-2026-1234** (CRITICAL) — \`lodash@4.17.20\`
   - Prototype pollution vulnerability
   - **Fix:** Run \`npm update lodash@4.17.21\`

2. **CVE-2026-7890** (CRITICAL) — \`node-fetch@2.6.0\`
   - Information exposure through error messages
   - **Fix:** Run \`npm update node-fetch@2.7.0\`

### Recommended Steps:

1. Update the vulnerable packages listed above
2. Run \`npm audit\` locally to verify all issues are resolved
3. Commit the updated \`package-lock.json\`
4. Re-trigger the deployment pipeline

The deployment was automatically blocked per the zero-trust security policy. Once the vulnerabilities are patched, the pipeline will proceed to the infrastructure provisioning stage.`,
    timestamp: "2026-02-26T14:40:05Z",
  },
  {
    id: "msg-003",
    role: "user",
    content: "How do I check if my health check endpoint is configured correctly?",
    timestamp: "2026-02-26T14:42:00Z",
  },
  {
    id: "msg-004",
    role: "assistant",
    content: `## Health Check Configuration Guide

For ECS Fargate deployments, the Application Load Balancer (ALB) continuously pings your \`/health\` endpoint. Here's how to verify your configuration:

### 1. Verify the Endpoint Exists
Your application should expose a \`/health\` route that returns HTTP 200:

\`\`\`javascript
// Express.js example
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
\`\`\`

### 2. Check Target Group Settings
In the DeployGuard pre-flight page, ensure:
- **Health check path:** \`/health\`
- **Health check interval:** 30 seconds
- **Healthy threshold:** 3 consecutive successes
- **Unhealthy threshold:** 3 consecutive failures

### 3. Common Issues
- Health check returning 301/302 redirects (ensure no trailing slash redirect)
- Application not listening on the configured port
- SSL/TLS mismatch (ALB uses HTTP for health checks internally)

If the health check fails 3 consecutive times, DeployGuard will automatically trigger a zero-downtime rollback to the previous stable commit.`,
    timestamp: "2026-02-26T14:42:08Z",
  },
];

export const mockSystemMetrics = {
  totalProjects: 5,
  activeDeployments: 1,
  totalDeployments: 24,
  successRate: 87.5,
  totalVulnerabilities: 8,
  criticalVulnerabilities: 2,
  monthlyCost: 84.30,
  costSavings: 32.0,
  uptime: 99.97,
  avgBuildTime: 128,
};

export const mockMonitoringData = {
  cpuUsage: 42,
  memoryUsage: 67,
  requestLatency: 124,
  requestsPerMinute: 342,
  errorRate: 0.3,
  activeConnections: 89,
  networkIn: 2.4,
  networkOut: 5.8,
};

export const stackDetectionResults = {
  language: "Node.js",
  languageVersion: "20.x",
  framework: "Next.js 14",
  packageManager: "npm",
  buildCommand: "npm run build",
  startCommand: "npm start",
  port: 3000,
  detectedFiles: [
    { name: "package.json", purpose: "Dependency manifest" },
    { name: "next.config.js", purpose: "Next.js configuration" },
    { name: "tsconfig.json", purpose: "TypeScript configuration" },
    { name: ".env.example", purpose: "Environment variables template" },
    { name: "Dockerfile", purpose: "Custom Docker configuration (user-provided)" },
  ],
  preFlightChecks: [
    { name: "Repository clone", status: "passed", details: "Shallow clone successful (12.3 MB)" },
    { name: "Stack detection", status: "passed", details: "Next.js 14 detected via package.json + next.config.js" },
    { name: "Template matching", status: "passed", details: "Matched to Next.js SSR template (multi-stage build)" },
    { name: "Environment variables", status: "warning", details: "3 of 5 required variables configured" },
    { name: "Port configuration", status: "passed", details: "Port 3000 detected from next.config.js" },
    { name: "Health check endpoint", status: "passed", details: "/health endpoint found in route definitions" },
    { name: "Build command", status: "passed", details: "npm run build validated" },
    { name: "Security baseline", status: "pending", details: "Trivy scan will run after image build" },
  ],
  dockerTemplate: `# DeployGuard Auto-Generated Dockerfile
# Template: nextjs-ssr (v2.1.0)
# Base: node:20-alpine (distroless variant)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs20-debian12 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \\
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["server.js"]`,
};

export const mockInfrastructureResources = [
  { type: "VPC", name: "deployguard-vpc-proj-001", region: "us-east-1", status: "running", cost: "Free Tier" },
  { type: "ECS Cluster", name: "deployguard-ecommerce-cluster", region: "us-east-1", status: "running", cost: "$28.60/mo" },
  { type: "ALB", name: "deployguard-ecommerce-alb", region: "us-east-1", status: "running", cost: "$16.20/mo" },
  { type: "NAT Gateway", name: "deployguard-nat-gw", region: "us-east-1", status: "running", cost: "$32.40/mo" },
  { type: "EFS", name: "deployguard-ecommerce-efs", region: "us-east-1", status: "running", cost: "$3.00/mo" },
  { type: "ECR Repository", name: "acme/ecommerce-platform", region: "us-east-1", status: "running", cost: "$0.10/mo" },
  { type: "S3 Bucket", name: "deployguard-tfstate-proj-001", region: "us-east-1", status: "running", cost: "$0.05/mo" },
  { type: "DynamoDB Table", name: "deployguard-locks-proj-001", region: "us-east-1", status: "running", cost: "Free Tier" },
  { type: "CloudWatch Log Group", name: "/ecs/deployguard-ecommerce", region: "us-east-1", status: "running", cost: "$3.50/mo" },
  { type: "Cloud Map Namespace", name: "deployguard-ecommerce.local", region: "us-east-1", status: "running", cost: "Free Tier" },
];

export const mockBillingData = {
  currentPlan: "pro",
  monthlyPrice: 29.00,
  nextBillingDate: "2026-03-26",
  projectsUsed: 5,
  projectsLimit: 20,
  deploymentsThisMonth: 24,
  costThisMonth: 84.30,
  invoices: [
    { id: "INV-2026-02", date: "2026-02-01", amount: 29.00, status: "paid" },
    { id: "INV-2026-01", date: "2026-01-01", amount: 29.00, status: "paid" },
    { id: "INV-2025-12", date: "2025-12-01", amount: 0.00, status: "paid" },
  ],
  plans: [
    {
      name: "Free",
      price: 0,
      features: ["3 Projects", "5 Deployments/month", "Basic Security Scanning", "Community Support"],
    },
    {
      name: "Pro",
      price: 29,
      features: [
        "20 Projects",
        "Unlimited Deployments",
        "Advanced Security (Trivy)",
        "Cost Analysis (Infracost)",
        "AI Chatbot Support",
        "Priority Support",
        "Terraform Export",
      ],
    },
  ],
};
