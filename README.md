🚀 DeployGuard
A Reliable Repository Scanning & Deployment Orchestration Platform
DeployGuard is a zero‑configuration DevOps orchestration system designed for startups and SMEs. It automatically scans application repositories, detects technology stacks using a deterministic expert system, generates optimized containerization templates, enforces security gates, estimates cloud costs, provisions infrastructure, and deploys applications with built‑in self‑healing and AI‑assisted troubleshooting.

📌 Problem
Small teams struggle with:

Complex cloud infrastructure setup
DevOps skill gaps
Manual Docker & Terraform configuration
Unexpected AWS billing (“bill shock”)
Vulnerable container deployments
Debugging cryptic deployment failures
DeployGuard solves these challenges with automated, secure, and explainable orchestration.

🧠 Core Features
✅ Zero-Configuration Deployment
Connect GitHub repository
Automatic stack detection
Auto-generated production-grade Docker templates
One-click AWS deployment
🔍 Deterministic Stack Detection (Expert System)
File signature analysis (no ML guessing)
Supports:
Node.js (Express, NestJS, Fastify)
Next.js
React (Static)
Python (Django, Flask, FastAPI)
Detects:
Language
Framework
Runtime version
Package manager
Build command
Application port
🐳 Production-Optimized Container Templates
Multi-stage builds
Alpine / Distroless base images
Dependency layer caching
Parameterized runtime versions
Minimal attack surface
🔐 DevSecOps Security Gate (Trivy Integration)
Container vulnerability scanning
Blocks deployment if:
Any Critical vulnerability
Any High vulnerability
Structured dashboard report
CVE tracking & remediation suggestions
Historical scan tracking
💰 Predictive Cost Estimation (FinOps)
Terraform plan parsing
Infracost integration
Pre-deployment monthly cost estimate
Explicit user approval required
🏗 Infrastructure as Code (Terraform)
AWS ECS Fargate Spot
VPC, Subnets, ALB
ECR image storage
EFS persistent storage
Cloud Map service discovery
🔒 Distributed State Locking
S3 remote state storage (versioned)
DynamoDB lock table
Per-project isolation
Deadlock detection & cleanup
Custom deployment state machine
🔄 Self-Healing Architecture
Failure Type	Automatic Recovery
Container crash	ECS replacement
Crash loop	Zero-downtime rollback
Spot interruption	Automatic task replacement
Traffic spike	Auto-scaling (CPU target tracking)
🤖 AI Log Translator
Uses pre-trained LLM via API (no model training)
Multi-source log ingestion:
Build logs
Terraform logs
Trivy results
Runtime logs
Intelligent error extraction
Root cause explanation
Actionable remediation steps
One-click "Analyze Failure"
📊 Observability
Real-time deployment tracking
Pipeline stage visualization
SSE log streaming
Scaling event tracking
Vulnerability trend monitoring
🏗 System Architecture Overview
Frontend:

Next.js Dashboard
Chatbot Interface
Real-time monitoring UI
Backend:

NestJS Orchestration Engine
Redis (BullMQ) job queue
PostgreSQL (audit logging)
GitHub integration
LLM API integration
Cloud:

AWS ECS Fargate Spot
ECR
ALB
S3 (state storage)
DynamoDB (locking)
EFS
EventBridge (Spot interruption handling)
Security & FinOps:

Aqua Trivy
Infracost
🛠 Tech Stack
Layer	Technology
Frontend	Next.js (React)
Backend	NestJS (Node.js)
Database	PostgreSQL
Queue	Redis (BullMQ)
IaC	HashiCorp Terraform
Cloud	AWS (ECS, ECR, S3, ALB, DynamoDB, EFS)
Security	Aqua Trivy
Cost Estimation	Infracost
CI/CD	GitHub Actions
AI	Pre-trained LLM via API
📂 Project Structure (High-Level)
text

deployguard/
│
├── frontend/              # Next.js Dashboard
├── backend/               # NestJS API & Orchestration
├── terraform-modules/     # Infrastructure templates
├── template-registry/     # Docker blueprints
├── detection-engine/      # Stack detection logic
├── security-gate/         # Trivy integration
└── docs/                  # Documentation
⚙️ Deployment Workflow
User connects GitHub repository
Stack detection engine analyzes file signatures
Pre-flight validation report generated
Docker template selected & parameterized
Image built via CI/CD
Trivy scan executed
Cost estimation generated
User approves estimate
Terraform provisions infrastructure
ECS deploys container
Health checks & auto-scaling enabled
Monitoring & AI troubleshooting available
🚦 Deployment State Machine
text

Queued
 → Building
 → Scanning
 → Estimating
 → Awaiting Approval
 → Provisioning
 → Deploying
 → Deployed | Failed
🔐 Security Policy
Critical/High vulnerabilities → Deployment Blocked
All deployments scanned
Immutable audit logging
Remote Terraform state locking
Encrypted storage (S3 + EFS)
📌 Limitations
AWS-only (multi-cloud not supported)
GitHub repositories only
Template-supported stacks only
Relies on Fargate Spot (possible interruption)
🎓 Academic Contribution
DeployGuard implements:

Deterministic Expert System for stack detection
Parameterized container template registry
Custom deployment state machine
Multi-layer distributed locking architecture
Crash-loop rollback automation
Structured AI-assisted log interpretation
This project demonstrates applied cloud engineering, DevSecOps automation, infrastructure governance, and intelligent orchestration design.

👨‍💻 Authors
Hassan Sajjad – Cloud Architect & IaC Engineer
Faria Fatima – Backend Orchestration Engineer
Tania Khawar – Frontend & AI Integration Specialist
Supervisor: Sir Yaseen Mushtaq
Air University Islamabad – Department of Computer Science


