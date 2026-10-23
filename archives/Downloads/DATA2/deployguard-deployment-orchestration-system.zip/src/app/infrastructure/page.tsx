import {
  Cloud,
  Server,
  Database,
  HardDrive,
  Shield,
  Lock,
  Unlock,
  Trash2,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { mockInfrastructureResources } from "@/lib/mock-data";

function ResourceTypeIcon({ type }: { type: string }) {
  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    VPC: Cloud,
    "ECS Cluster": Server,
    ALB: Server,
    "NAT Gateway": Server,
    EFS: HardDrive,
    "ECR Repository": Database,
    "S3 Bucket": Database,
    "DynamoDB Table": Database,
    "CloudWatch Log Group": Database,
    "Cloud Map Namespace": Cloud,
  };
  const Icon = iconMap[type] || Server;
  return <Icon className="w-4 h-4" />;
}

export default function InfrastructurePage() {
  const resources = mockInfrastructureResources;
  const runningCount = resources.filter((r) => r.status === "running").length;
  const totalCost = resources.reduce((sum, r) => {
    const match = r.cost.match(/\$(\d+\.?\d*)/);
    return sum + (match ? parseFloat(match[1]) : 0);
  }, 0);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Infrastructure Management</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            AWS resources, Terraform state locking & lifecycle management
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-2 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
            Sync State
          </button>
        </div>
      </div>

      {/* Infrastructure Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Total Resources</p>
          <p className="text-2xl font-bold mt-1">{resources.length}</p>
          <p className="text-xs text-deployguard-400">{runningCount} running</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Monthly Cost</p>
          <p className="text-2xl font-bold mt-1 text-accent-orange">${totalCost.toFixed(2)}</p>
          <p className="text-xs text-deployguard-400">Infrastructure only</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">State Lock</p>
          <div className="flex items-center gap-2 mt-1">
            <Unlock className="w-5 h-5 text-accent-cyan" />
            <span className="text-lg font-bold text-accent-cyan">Unlocked</span>
          </div>
          <p className="text-xs text-deployguard-400">DynamoDB distributed lock</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">State Storage</p>
          <div className="flex items-center gap-2 mt-1">
            <Shield className="w-5 h-5 text-accent-cyan" />
            <span className="text-lg font-bold text-accent-cyan">S3</span>
          </div>
          <p className="text-xs text-deployguard-400">Versioning enabled</p>
        </div>
      </div>

      {/* Resources Table */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">AWS Resources</h2>
          <p className="text-xs text-deployguard-400 mt-0.5">
            Provisioned via HashiCorp Terraform with remote state locking
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Type</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Name</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Region</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Status</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {resources.map((resource, i) => (
                <tr key={i} className="hover:bg-deployguard-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <ResourceTypeIcon type={resource.type} />
                      <span className="text-deployguard-300">{resource.type}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-accent-blue">{resource.name}</td>
                  <td className="px-5 py-3 text-deployguard-400">{resource.region}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-accent-cyan">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {resource.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-deployguard-300">{resource.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* State Locking Details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-deployguard-900 border border-border rounded-xl">
          <div className="p-5 border-b border-border">
            <h2 className="font-semibold">Distributed State Locking</h2>
            <p className="text-xs text-deployguard-400 mt-0.5">
              S3 + DynamoDB — Prevents concurrent state corruption
            </p>
          </div>
          <div className="p-5 space-y-4">
            {[
              { label: "Lock Storage", value: "DynamoDB (deployguard-locks-proj-001)", icon: Lock },
              { label: "State Storage", value: "S3 (deployguard-tfstate-proj-001)", icon: Database },
              { label: "Versioning", value: "Enabled (S3)", icon: CheckCircle2 },
              { label: "Heartbeat Interval", value: "30 seconds", icon: RefreshCw },
              { label: "Orphan Timeout", value: "5 minutes", icon: AlertTriangle },
              { label: "Encryption", value: "AWS KMS (at rest)", icon: Shield },
            ].map((item, i) => {
              const ItemIcon = item.icon;
              return (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 text-deployguard-400">
                    <ItemIcon className="w-4 h-4" />
                    {item.label}
                  </div>
                  <span className="text-deployguard-200 font-medium">{item.value}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-deployguard-900 border border-border rounded-xl">
          <div className="p-5 border-b border-border">
            <h2 className="font-semibold">State Lock Protocol</h2>
            <p className="text-xs text-deployguard-400 mt-0.5">
              How concurrent deployments are coordinated
            </p>
          </div>
          <div className="p-5 space-y-3">
            {[
              { step: "1", title: "Acquire Lock", desc: "Conditional write to DynamoDB. If lock exists, deployment queues." },
              { step: "2", title: "Heartbeat", desc: "Background process updates timestamp every 30s while deployment runs." },
              { step: "3", title: "Execute Terraform", desc: "With lock held, Terraform plan & apply proceed safely." },
              { step: "4", title: "Release Lock", desc: "On success or failure, lock is released. Next queued deployment starts." },
              { step: "5", title: "Orphan Recovery", desc: "If heartbeat stops for 5min, lock is force-released after safety checks." },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-accent-cyan/15 text-accent-cyan flex items-center justify-center text-xs font-bold flex-shrink-0">
                  {item.step}
                </div>
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-deployguard-400">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Destroy Section */}
      <div className="bg-accent-red/5 border border-accent-red/20 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <AlertTriangle className="w-8 h-8 text-accent-red flex-shrink-0" />
          <div className="flex-1">
            <h2 className="text-lg font-bold text-accent-red">Infrastructure Demolition</h2>
            <p className="text-sm text-deployguard-300 mt-1">
              Execute <code className="bg-deployguard-800 px-1.5 py-0.5 rounded text-xs">terraform destroy</code> to safely tear down all active AWS environments.
              This requires dual-confirmation. EFS volumes will be preserved to prevent data loss.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button className="flex items-center gap-2 bg-accent-red/15 border border-accent-red/30 text-accent-red px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-red/25 transition-colors">
                <Trash2 className="w-4 h-4" />
                Destroy Infrastructure
              </button>
              <span className="text-xs text-deployguard-500">
                Requires dual-confirmation workflow
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
