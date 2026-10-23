import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  ChevronDown,
  Download,
  Filter,
  Search,
} from "lucide-react";
import { mockVulnerabilities, mockProjects } from "@/lib/mock-data";

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    critical: "bg-accent-red/15 text-accent-red border-accent-red/30",
    high: "bg-accent-orange/15 text-accent-orange border-accent-orange/30",
    medium: "bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30",
    low: "bg-deployguard-500/20 text-deployguard-400 border-deployguard-500/30",
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase border ${styles[severity]}`}>
      {severity}
    </span>
  );
}

export default function SecurityPage() {
  const project = mockProjects[0];
  const critical = mockVulnerabilities.filter((v) => v.severity === "critical");
  const high = mockVulnerabilities.filter((v) => v.severity === "high");
  const medium = mockVulnerabilities.filter((v) => v.severity === "medium");
  const low = mockVulnerabilities.filter((v) => v.severity === "low");

  const scanBlocked = critical.length > 0 || high.length > 0;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Security Scanning</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Aqua Trivy vulnerability analysis & policy enforcement
          </p>
        </div>
        <button className="flex items-center gap-2 bg-deployguard-800 border border-border px-4 py-2 rounded-lg text-sm text-deployguard-300 hover:text-white hover:border-border-light transition-colors">
          <Download className="w-4 h-4" />
          Export Report
        </button>
      </div>

      {/* Scan Status Banner */}
      <div
        className={`rounded-xl border p-5 flex items-center gap-4 ${
          scanBlocked
            ? "bg-accent-red/5 border-accent-red/20"
            : "bg-accent-cyan/5 border-accent-cyan/20"
        }`}
      >
        {scanBlocked ? (
          <ShieldAlert className="w-8 h-8 text-accent-red flex-shrink-0" />
        ) : (
          <ShieldCheck className="w-8 h-8 text-accent-cyan flex-shrink-0" />
        )}
        <div>
          <h2 className={`text-lg font-bold ${scanBlocked ? "text-accent-red" : "text-accent-cyan"}`}>
            {scanBlocked ? "Deployment Blocked" : "Scan Passed"}
          </h2>
          <p className="text-sm text-deployguard-300 mt-0.5">
            {scanBlocked
              ? `${critical.length} critical and ${high.length} high severity vulnerabilities found. Deployment blocked per zero-trust security policy.`
              : "No critical or high severity vulnerabilities detected. Deployment may proceed."}
          </p>
        </div>
      </div>

      {/* Severity Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Critical", count: critical.length, color: "text-accent-red", bg: "bg-accent-red/10", border: "border-accent-red/20" },
          { label: "High", count: high.length, color: "text-accent-orange", bg: "bg-accent-orange/10", border: "border-accent-orange/20" },
          { label: "Medium", count: medium.length, color: "text-accent-yellow", bg: "bg-accent-yellow/10", border: "border-accent-yellow/20" },
          { label: "Low", count: low.length, color: "text-deployguard-400", bg: "bg-deployguard-700/20", border: "border-deployguard-600/20" },
        ].map((item) => (
          <div
            key={item.label}
            className={`${item.bg} border ${item.border} rounded-xl p-4 text-center`}
          >
            <p className={`text-3xl font-bold ${item.color}`}>{item.count}</p>
            <p className="text-xs text-deployguard-400 uppercase tracking-wider mt-1">
              {item.label}
            </p>
          </div>
        ))}
      </div>

      {/* Vulnerability Table */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-semibold">Vulnerability Details</h2>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 text-xs text-deployguard-400 hover:text-white bg-deployguard-800 px-3 py-1.5 rounded-lg transition-colors">
              <Filter className="w-3 h-3" />
              Filter
            </button>
            <button className="flex items-center gap-1.5 text-xs text-deployguard-400 hover:text-white bg-deployguard-800 px-3 py-1.5 rounded-lg transition-colors">
              <Search className="w-3 h-3" />
              Search
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">CVE ID</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Severity</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Package</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Installed</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Fixed</th>
                <th className="text-left px-5 py-3 text-xs text-deployguard-400 uppercase tracking-wider font-medium">Remediation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {mockVulnerabilities.map((vuln) => (
                <tr key={vuln.id} className="hover:bg-deployguard-800/30 transition-colors">
                  <td className="px-5 py-3">
                    <code className="text-xs text-accent-blue">{vuln.cveId}</code>
                  </td>
                  <td className="px-5 py-3">
                    <SeverityBadge severity={vuln.severity} />
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">{vuln.packageName}</td>
                  <td className="px-5 py-3 text-deployguard-400 text-xs font-mono">{vuln.installedVersion}</td>
                  <td className="px-5 py-3 text-accent-cyan text-xs font-mono">{vuln.fixedVersion}</td>
                  <td className="px-5 py-3">
                    <code className="text-xs bg-deployguard-800 px-2 py-1 rounded text-accent-cyan">
                      {vuln.remediation}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Policy Rules */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">Security Policy Rules</h2>
          <p className="text-xs text-deployguard-400 mt-1">
            Rule-based policy engine — no ML inference, deterministic enforcement
          </p>
        </div>
        <div className="divide-y divide-border">
          {[
            { rule: "Critical/High Severity → Block Deployment", status: "ENFORCED", description: "Any critical or high severity finding automatically blocks the deployment pipeline" },
            { rule: "Medium Severity (threshold > 3) → Require Approval", status: "ENFORCED", description: "Medium severity findings above configurable threshold require manual user review" },
            { rule: "Low Severity → Record Only", status: "ENFORCED", description: "Low severity findings are logged for awareness but do not block deployment" },
            { rule: "Base Image Vulnerability → Recommend Update", status: "ENFORCED", description: "Vulnerable base images trigger recommendations for updated distroless/alpine tags" },
            { rule: "All Scan Results → Immutable Audit Log", status: "ENFORCED", description: "Every scan result, policy decision, and user override is persisted in PostgreSQL audit logs" },
          ].map((policy, i) => (
            <div key={i} className="p-4 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-accent-cyan flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{policy.rule}</p>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent-cyan/15 text-accent-cyan">
                    {policy.status}
                  </span>
                </div>
                <p className="text-xs text-deployguard-400 mt-0.5">{policy.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
