import {
  FolderKanban,
  Rocket,
  ShieldAlert,
  DollarSign,
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  TrendingUp,
  Zap,
  ArrowUpRight,
} from "lucide-react";
import Link from "next/link";
import {
  mockProjects,
  mockDeployments,
  mockSystemMetrics,
  mockNotifications,
  mockAuditLogs,
} from "@/lib/mock-data";

function StatCard({
  label,
  value,
  subtext,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  subtext?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className="bg-deployguard-900 border border-border rounded-xl p-5 hover:border-border-light transition-colors">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-deployguard-400 uppercase tracking-wider font-medium">{label}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {subtext && <p className="text-xs text-deployguard-400 mt-1">{subtext}</p>}
        </div>
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-accent-cyan/15 text-accent-cyan",
    deploying: "bg-accent-blue/15 text-accent-blue",
    failed: "bg-accent-red/15 text-accent-red",
    idle: "bg-deployguard-500/20 text-deployguard-400",
    deployed: "bg-accent-cyan/15 text-accent-cyan",
    queued: "bg-accent-yellow/15 text-accent-yellow",
    building: "bg-accent-blue/15 text-accent-blue",
    scanning: "bg-accent-purple/15 text-accent-purple",
    provisioning: "bg-accent-orange/15 text-accent-orange",
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-deployguard-600/20 text-deployguard-300"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function DashboardPage() {
  const metrics = mockSystemMetrics;
  const recentDeployments = mockDeployments.slice(0, 4);
  const recentLogs = mockAuditLogs.slice(0, 5);
  const unreadNotifications = mockNotifications.filter((n) => !n.read);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Welcome back, Hassan. Here&apos;s your infrastructure overview.
          </p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-4 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Rocket className="w-4 h-4" />
          New Deployment
        </Link>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Projects"
          value={metrics.totalProjects}
          subtext={`${metrics.activeDeployments} deploying now`}
          icon={FolderKanban}
          color="bg-accent-blue/15 text-accent-blue"
        />
        <StatCard
          label="Success Rate"
          value={`${metrics.successRate}%`}
          subtext={`${metrics.totalDeployments} total deployments`}
          icon={TrendingUp}
          color="bg-accent-cyan/15 text-accent-cyan"
        />
        <StatCard
          label="Vulnerabilities"
          value={metrics.totalVulnerabilities}
          subtext={`${metrics.criticalVulnerabilities} critical`}
          icon={ShieldAlert}
          color="bg-accent-red/15 text-accent-red"
        />
        <StatCard
          label="Monthly Cost"
          value={`$${metrics.monthlyCost}`}
          subtext={`$${metrics.costSavings} saved with Spot`}
          icon={DollarSign}
          color="bg-accent-orange/15 text-accent-orange"
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <Activity className="w-4 h-4 text-accent-cyan" />
            <span className="text-sm font-medium text-deployguard-300">System Uptime</span>
          </div>
          <p className="text-3xl font-bold text-accent-cyan">{metrics.uptime}%</p>
          <div className="mt-2 h-1.5 bg-deployguard-800 rounded-full overflow-hidden">
            <div className="h-full bg-accent-cyan rounded-full" style={{ width: `${metrics.uptime}%` }} />
          </div>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <Clock className="w-4 h-4 text-accent-blue" />
            <span className="text-sm font-medium text-deployguard-300">Avg Build Time</span>
          </div>
          <p className="text-3xl font-bold text-accent-blue">{metrics.avgBuildTime}s</p>
          <p className="text-xs text-deployguard-400 mt-1">Build + Scan + Deploy pipeline</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <Zap className="w-4 h-4 text-accent-yellow" />
            <span className="text-sm font-medium text-deployguard-300">Notifications</span>
          </div>
          <p className="text-3xl font-bold text-accent-yellow">{unreadNotifications.length}</p>
          <p className="text-xs text-deployguard-400 mt-1">Unread alerts requiring attention</p>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Projects */}
        <div className="lg:col-span-2 bg-deployguard-900 border border-border rounded-xl">
          <div className="flex items-center justify-between p-5 border-b border-border">
            <h2 className="font-semibold">Active Projects</h2>
            <Link href="/projects" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {mockProjects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="flex items-center justify-between p-4 hover:bg-deployguard-800/50 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-deployguard-800 flex items-center justify-center text-xs font-bold text-accent-blue">
                    {project.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{project.name}</p>
                    <p className="text-xs text-deployguard-400">
                      {project.detectedStack.framework} • {project.awsRegion}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right hidden sm:block">
                    <p className="text-xs text-deployguard-400">Last Deploy</p>
                    <p className="text-xs">{new Date(project.lastDeployed).toLocaleDateString()}</p>
                  </div>
                  <StatusBadge status={project.status} />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent Notifications & Activity */}
        <div className="space-y-6">
          {/* Notifications */}
          <div className="bg-deployguard-900 border border-border rounded-xl">
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="font-semibold">Notifications</h2>
              <Link href="/notifications" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
                View All <ArrowUpRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-border">
              {mockNotifications.slice(0, 4).map((notif) => {
                const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
                  deployment: CheckCircle2,
                  security: ShieldAlert,
                  cost: DollarSign,
                  infrastructure: AlertTriangle,
                  rollback: XCircle,
                };
                const Icon = iconMap[notif.type] || Activity;
                const colorMap: Record<string, string> = {
                  deployment: "text-accent-cyan",
                  security: "text-accent-red",
                  cost: "text-accent-orange",
                  infrastructure: "text-accent-yellow",
                  rollback: "text-accent-red",
                };
                return (
                  <div
                    key={notif.id}
                    className={`p-4 flex items-start gap-3 ${!notif.read ? "bg-deployguard-800/30" : ""}`}
                  >
                    <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${colorMap[notif.type] || "text-deployguard-400"}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{notif.title}</p>
                      <p className="text-xs text-deployguard-400 mt-0.5 line-clamp-2">{notif.message}</p>
                      <p className="text-[10px] text-deployguard-500 mt-1">
                        {new Date(notif.timestamp).toLocaleString()}
                      </p>
                    </div>
                    {!notif.read && <div className="w-2 h-2 rounded-full bg-accent-cyan flex-shrink-0 mt-1.5" />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-deployguard-900 border border-border rounded-xl">
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="font-semibold">Recent Activity</h2>
            </div>
            <div className="p-4 space-y-3">
              {recentLogs.map((log) => {
                const severityColors: Record<string, string> = {
                  info: "border-l-deployguard-500",
                  warning: "border-l-accent-orange",
                  error: "border-l-accent-red",
                  success: "border-l-accent-cyan",
                };
                return (
                  <div
                    key={log.id}
                    className={`border-l-2 ${severityColors[log.severity]} pl-3 py-1`}
                  >
                    <p className="text-xs font-medium">{log.action}</p>
                    <p className="text-[10px] text-deployguard-400">{log.resource} • {new Date(log.timestamp).toLocaleTimeString()}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Recent Deployments Table */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-semibold">Recent Deployments</h2>
          <Link href="/monitoring" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
            View Pipeline <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Commit</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Message</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Status</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Build</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Scan</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {recentDeployments.map((dep) => (
                <tr key={dep.id} className="hover:bg-deployguard-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <code className="text-xs bg-deployguard-800 px-2 py-1 rounded text-accent-blue">{dep.commitHash}</code>
                  </td>
                  <td className="px-5 py-3 text-deployguard-300 max-w-[200px] truncate">{dep.commitMessage}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={dep.status} />
                  </td>
                  <td className="px-5 py-3 text-deployguard-300">{dep.buildDuration}s</td>
                  <td className="px-5 py-3 text-deployguard-300">{dep.scanDuration}s</td>
                  <td className="px-5 py-3 text-deployguard-300">{dep.estimatedCost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
