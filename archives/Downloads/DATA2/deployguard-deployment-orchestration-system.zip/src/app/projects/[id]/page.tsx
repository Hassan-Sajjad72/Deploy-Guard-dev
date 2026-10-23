import Link from "next/link";
import {
  ArrowRight,
  Globe,
  GitBranch,
  Clock,
  ShieldCheck,
  DollarSign,
  Activity,
  Cloud,
  FileDown,
  Code2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { mockProjects, mockDeployments } from "@/lib/mock-data";

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-accent-cyan/15 text-accent-cyan",
    deploying: "bg-accent-blue/15 text-accent-blue",
    failed: "bg-accent-red/15 text-accent-red",
    idle: "bg-deployguard-500/20 text-deployguard-400",
    deployed: "bg-accent-cyan/15 text-accent-cyan",
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-deployguard-600/20 text-deployguard-300"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function ProjectDetailPage() {
  const project = mockProjects[0];
  const deployments = mockDeployments.filter((d) => d.projectId === project.id);

  const quickActions = [
    { label: "Pre-Flight Validation", description: "Stack detection & checks", href: `/projects/${project.id}/preflight`, icon: ShieldCheck, color: "text-accent-cyan" },
    { label: "Security Scans", description: "Trivy vulnerability reports", href: "/security", icon: ShieldCheck, color: "text-accent-red" },
    { label: "Cost Analysis", description: "Infracost estimation", href: "/cost-analysis", icon: DollarSign, color: "text-accent-orange" },
    { label: "Monitoring", description: "Live metrics & logs", href: "/monitoring", icon: Activity, color: "text-accent-blue" },
    { label: "Infrastructure", description: "AWS resources & state", href: "/infrastructure", icon: Cloud, color: "text-accent-purple" },
    { label: "Terraform Export", description: "No lock-in download", href: "/terraform-export", icon: FileDown, color: "text-accent-yellow" },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-deployguard-400 mb-2">
          <Link href="/projects" className="hover:text-white transition-colors">Projects</Link>
          <span>/</span>
          <span className="text-white">{project.name}</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <StatusBadge status={project.status} />
          </div>
          <Link
            href={`/projects/${project.id}/preflight`}
            className="flex items-center gap-2 bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90"
          >
            Deploy Now
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Project Info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-3">
            <Code2 className="w-3.5 h-3.5" />
            Technology Stack
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-deployguard-400">Language</span>
              <span className="font-medium">{project.detectedStack.language}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Framework</span>
              <span className="font-medium">{project.detectedStack.framework}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Package Manager</span>
              <span className="font-medium">{project.detectedStack.packageManager}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Port</span>
              <span className="font-medium">{project.detectedStack.port}</span>
            </div>
          </div>
        </div>

        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-3">
            <Globe className="w-3.5 h-3.5" />
            Repository & Region
          </div>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-deployguard-400 block text-xs">Repository</span>
              <a href={project.repositoryUrl} className="text-accent-blue hover:underline truncate block">{project.repositoryUrl}</a>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Branch</span>
              <span className="font-medium flex items-center gap-1">
                <GitBranch className="w-3 h-3" /> {project.branch}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Region</span>
              <span className="font-medium">{project.awsRegion}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Last Deploy</span>
              <span className="font-medium">{new Date(project.lastDeployed).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 text-xs text-deployguard-400 mb-3">
            <Activity className="w-3.5 h-3.5" />
            Deployment Summary
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-deployguard-400">Total Deploys</span>
              <span className="font-medium">{deployments.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Successful</span>
              <span className="font-medium text-accent-cyan">{deployments.filter(d => d.status === "deployed").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Failed</span>
              <span className="font-medium text-accent-red">{deployments.filter(d => d.status === "failed").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-deployguard-400">Est. Cost</span>
              <span className="font-medium text-accent-orange">{deployments[0]?.estimatedCost || "N/A"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="font-semibold mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.label}
                href={action.href}
                className="group bg-deployguard-900 border border-border rounded-xl p-4 flex items-center gap-4 hover:border-border-light transition-all"
              >
                <div className={`p-2.5 rounded-lg bg-deployguard-800 ${action.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium group-hover:text-accent-cyan transition-colors">{action.label}</p>
                  <p className="text-xs text-deployguard-400">{action.description}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-deployguard-600 group-hover:text-accent-cyan transition-colors" />
              </Link>
            );
          })}
        </div>
      </div>

      {/* Recent Deployments */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">Deployment History</h2>
        </div>
        <div className="divide-y divide-border">
          {deployments.map((dep) => (
            <div key={dep.id} className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                {dep.status === "deployed" ? (
                  <CheckCircle2 className="w-5 h-5 text-accent-cyan" />
                ) : dep.status === "failed" ? (
                  <XCircle className="w-5 h-5 text-accent-red" />
                ) : (
                  <Loader2 className="w-5 h-5 text-accent-blue animate-spin" />
                )}
                <div>
                  <p className="text-sm font-medium">{dep.commitMessage}</p>
                  <div className="flex items-center gap-3 text-xs text-deployguard-400 mt-0.5">
                    <code className="bg-deployguard-800 px-1.5 py-0.5 rounded text-accent-blue">{dep.commitHash}</code>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{dep.buildDuration + dep.scanDuration + dep.deployDuration}s total</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-deployguard-400">{dep.estimatedCost}</span>
                <StatusBadge status={dep.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
