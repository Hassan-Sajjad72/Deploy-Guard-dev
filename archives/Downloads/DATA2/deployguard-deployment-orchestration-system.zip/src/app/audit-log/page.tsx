import {
  ScrollText,
  Filter,
  Search,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Clock,
} from "lucide-react";
import { mockAuditLogs } from "@/lib/mock-data";

function SeverityIcon({ severity }: { severity: string }) {
  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    info: Info,
    warning: AlertTriangle,
    error: XCircle,
    success: CheckCircle2,
  };
  const colorMap: Record<string, string> = {
    info: "text-deployguard-400",
    warning: "text-accent-orange",
    error: "text-accent-red",
    success: "text-accent-cyan",
  };
  const Icon = iconMap[severity] || Info;
  return <Icon className={`w-4 h-4 ${colorMap[severity]}`} />;
}

export default function AuditLogPage() {
  const logs = mockAuditLogs;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Immutable record of every system action for enterprise compliance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <Filter className="w-3 h-3" />
            Filter
          </button>
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <Search className="w-3 h-3" />
            Search
          </button>
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <Download className="w-3 h-3" />
            Export
          </button>
        </div>
      </div>

      {/* Info Banner */}
      <div className="bg-deployguard-800/30 border border-border rounded-xl p-4 flex items-center gap-3">
        <ScrollText className="w-5 h-5 text-accent-cyan flex-shrink-0" />
        <p className="text-sm text-deployguard-300">
          All audit logs are stored immutably in PostgreSQL with timestamps and user context.
          Records cannot be modified or deleted — ensuring full compliance traceability.
        </p>
      </div>

      {/* Audit Log Table */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Severity</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Action</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Resource</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">User</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Details</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-deployguard-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <SeverityIcon severity={log.severity} />
                  </td>
                  <td className="px-5 py-3 font-medium">{log.action}</td>
                  <td className="px-5 py-3 text-accent-blue text-xs font-mono">{log.resource}</td>
                  <td className="px-5 py-3 text-deployguard-300">{log.user}</td>
                  <td className="px-5 py-3 text-deployguard-400 text-xs max-w-xs truncate">
                    {log.details}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5 text-deployguard-400 text-xs">
                      <Clock className="w-3 h-3" />
                      {new Date(log.timestamp).toLocaleString()}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Log Categories */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { category: "Deployments", count: 3, color: "text-accent-cyan" },
          { category: "Security Events", count: 2, color: "text-accent-red" },
          { category: "Cost Approvals", count: 1, color: "text-accent-orange" },
          { category: "User Activity", count: 4, color: "text-accent-blue" },
        ].map((item) => (
          <div key={item.category} className="bg-deployguard-900 border border-border rounded-xl p-4 text-center">
            <p className={`text-2xl font-bold ${item.color}`}>{item.count}</p>
            <p className="text-xs text-deployguard-400 mt-1">{item.category}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
