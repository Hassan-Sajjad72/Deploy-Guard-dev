import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  FileCode,
  Box,
  Terminal,
  ChevronDown,
  ExternalLink,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { stackDetectionResults, mockProjects } from "@/lib/mock-data";

function CheckStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="w-5 h-5 text-accent-cyan" />;
    case "warning":
      return <AlertTriangle className="w-5 h-5 text-accent-orange" />;
    case "failed":
      return <XCircle className="w-5 h-5 text-accent-red" />;
    case "pending":
      return <Clock className="w-5 h-5 text-deployguard-500" />;
    default:
      return <Clock className="w-5 h-5 text-deployguard-500" />;
  }
}

export default function PreflightPage() {
  const project = mockProjects[0];
  const results = stackDetectionResults;
  const passedChecks = results.preFlightChecks.filter((c) => c.status === "passed").length;
  const totalChecks = results.preFlightChecks.length;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-deployguard-400 mb-1">
            <Link href="/projects" className="hover:text-white transition-colors">Projects</Link>
            <span>/</span>
            <Link href={`/projects/${project.id}`} className="hover:text-white transition-colors">{project.name}</Link>
            <span>/</span>
            <span className="text-accent-cyan">Pre-Flight Validation</span>
          </div>
          <h1 className="text-2xl font-bold">Stack Detection & Pre-Flight</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Technology stack has been detected and pre-flight validation is complete
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Language</p>
          <p className="text-lg font-bold mt-1">{results.language}</p>
          <p className="text-xs text-deployguard-400">{results.languageVersion}</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Framework</p>
          <p className="text-lg font-bold mt-1">{results.framework}</p>
          <p className="text-xs text-deployguard-400">{results.packageManager}</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Port</p>
          <p className="text-lg font-bold mt-1">{results.port}</p>
          <p className="text-xs text-deployguard-400">Auto-detected</p>
        </div>
        <div className="bg-deployguard-900 border border-border rounded-xl p-4">
          <p className="text-xs text-deployguard-400 uppercase tracking-wider">Checks Passed</p>
          <p className="text-lg font-bold mt-1">
            <span className="text-accent-cyan">{passedChecks}</span>
            <span className="text-deployguard-500">/{totalChecks}</span>
          </p>
          <div className="mt-2 h-1.5 bg-deployguard-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-cyan rounded-full"
              style={{ width: `${(passedChecks / totalChecks) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pre-Flight Checks */}
        <div className="bg-deployguard-900 border border-border rounded-xl">
          <div className="p-5 border-b border-border">
            <h2 className="font-semibold">Pre-Flight Validation</h2>
            <p className="text-xs text-deployguard-400 mt-1">
              All checks must pass before deployment can proceed
            </p>
          </div>
          <div className="divide-y divide-border">
            {results.preFlightChecks.map((check, i) => (
              <div key={i} className="p-4 flex items-start gap-3">
                <CheckStatusIcon status={check.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{check.name}</p>
                  <p className={`text-xs mt-0.5 ${check.status === "passed" ? "text-deployguard-400" : check.status === "warning" ? "text-accent-orange" : "text-deployguard-500"}`}>
                    {check.details}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                    check.status === "passed"
                      ? "bg-accent-cyan/15 text-accent-cyan"
                      : check.status === "warning"
                      ? "bg-accent-orange/15 text-accent-orange"
                      : "bg-deployguard-700 text-deployguard-400"
                  }`}
                >
                  {check.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Detected Files */}
        <div className="space-y-6">
          <div className="bg-deployguard-900 border border-border rounded-xl">
            <div className="p-5 border-b border-border">
              <h2 className="font-semibold">Detected Configuration Files</h2>
              <p className="text-xs text-deployguard-400 mt-1">
                Files analyzed during stack detection
              </p>
            </div>
            <div className="divide-y divide-border">
              {results.detectedFiles.map((file, i) => (
                <div key={i} className="p-4 flex items-center gap-3">
                  <FileCode className="w-4 h-4 text-accent-blue flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-mono">{file.name}</p>
                    <p className="text-xs text-deployguard-400">{file.purpose}</p>
                  </div>
                  <ExternalLink className="w-3 h-3 text-deployguard-500" />
                </div>
              ))}
            </div>
          </div>

          {/* Build & Start Commands */}
          <div className="bg-deployguard-900 border border-border rounded-xl p-5">
            <h2 className="font-semibold mb-4">Build Configuration</h2>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-deployguard-400 mb-1">Build Command</p>
                <div className="flex items-center gap-2 bg-deployguard-800 rounded-lg px-3 py-2">
                  <Terminal className="w-4 h-4 text-accent-cyan flex-shrink-0" />
                  <code className="text-sm">{results.buildCommand}</code>
                </div>
              </div>
              <div>
                <p className="text-xs text-deployguard-400 mb-1">Start Command</p>
                <div className="flex items-center gap-2 bg-deployguard-800 rounded-lg px-3 py-2">
                  <Terminal className="w-4 h-4 text-accent-cyan flex-shrink-0" />
                  <code className="text-sm">{results.startCommand}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Docker Template Preview */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="font-semibold">Generated Docker Template</h2>
            <p className="text-xs text-deployguard-400 mt-1">
              Template: nextjs-ssr (v2.1.0) — Multi-stage build with distroless runner
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-accent-blue" />
            <span className="text-xs text-accent-blue font-medium">Auto-matched</span>
          </div>
        </div>
        <div className="p-5">
          <pre className="bg-deployguard-950 rounded-lg p-4 text-xs font-mono text-deployguard-300 overflow-x-auto leading-relaxed border border-border">
            {results.dockerTemplate}
          </pre>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-4">
        <Link
          href="/security"
          className="flex items-center gap-2 bg-gradient-to-r from-accent-cyan to-accent-blue text-deployguard-950 px-6 py-3 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
        >
          Proceed to Security Scan
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href="/cost-analysis"
          className="flex items-center gap-2 bg-deployguard-800 border border-border px-5 py-3 rounded-lg text-sm font-medium text-deployguard-300 hover:text-white hover:border-border-light transition-colors"
        >
          View Cost Estimate
        </Link>
      </div>
    </div>
  );
}
