import {
  Activity,
  Cpu,
  HardDrive,
  Clock,
  Wifi,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Server,
  Terminal,
  RefreshCw,
} from "lucide-react";
import { mockMonitoringData, mockProjects, mockDeployments } from "@/lib/mock-data";

function MetricCard({
  label,
  value,
  unit,
  trend,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  unit: string;
  trend?: "up" | "down" | "stable";
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className="bg-deployguard-900 border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs text-deployguard-400">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        {trend && (
          <span className={`flex items-center text-xs ${trend === "up" ? "text-accent-red" : trend === "down" ? "text-accent-cyan" : "text-deployguard-400"}`}>
            {trend === "up" ? <ArrowUpRight className="w-3 h-3" /> : trend === "down" ? <ArrowDownRight className="w-3 h-3" /> : null}
          </span>
        )}
      </div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-deployguard-500 mt-0.5">{unit}</p>
    </div>
  );
}

export default function MonitoringPage() {
  const data = mockMonitoringData;

  // Generate fake CPU chart data
  const cpuData = Array.from({ length: 24 }, () => 30 + Math.random() * 40);
  const memData = Array.from({ length: 24 }, () => 50 + Math.random() * 30);

  return (
    <div className="p-6 lg:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Monitoring & Observability</h1>
          <p className="text-deployguard-400 text-sm mt-1">
            Dual-stack monitoring — Pipeline metrics & Infrastructure telemetry
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-accent-cyan">
            <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse-dot" />
            Live
          </span>
          <button className="flex items-center gap-1.5 bg-deployguard-800 border border-border px-3 py-1.5 rounded-lg text-xs text-deployguard-300 hover:text-white transition-colors">
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      </div>

      {/* Real-time Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="CPU Usage" value={`${data.cpuUsage}%`} unit="ECS Fargate Tasks" trend="stable" icon={Cpu} color="text-accent-cyan" />
        <MetricCard label="Memory Usage" value={`${data.memoryUsage}%`} unit="Allocated Memory" trend="up" icon={HardDrive} color="text-accent-blue" />
        <MetricCard label="Request Latency" value={`${data.requestLatency}ms`} unit="p95 Response Time" trend="down" icon={Clock} color="text-accent-cyan" />
        <MetricCard label="Error Rate" value={`${data.errorRate}%`} unit="5xx Error Rate" trend="stable" icon={AlertTriangle} color="text-accent-orange" />
      </div>

      {/* Charts Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* CPU Chart */}
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-sm">CPU Utilization (24h)</h2>
            <span className="text-xs text-deployguard-400">Prometheus</span>
          </div>
          <div className="flex items-end gap-1 h-32">
            {cpuData.map((val, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end">
                <div
                  className="bg-gradient-to-t from-accent-cyan to-accent-blue rounded-t-sm"
                  style={{ height: `${val}%` }}
                  title={`CPU: ${val.toFixed(1)}%`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-[10px] text-deployguard-500">
            <span>24h ago</span>
            <span>12h ago</span>
            <span>Now</span>
          </div>
        </div>

        {/* Memory Chart */}
        <div className="bg-deployguard-900 border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-sm">Memory Utilization (24h)</h2>
            <span className="text-xs text-deployguard-400">Prometheus</span>
          </div>
          <div className="flex items-end gap-1 h-32">
            {memData.map((val, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end">
                <div
                  className="bg-gradient-to-t from-accent-blue to-accent-purple rounded-t-sm"
                  style={{ height: `${val}%` }}
                  title={`Memory: ${val.toFixed(1)}%`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-[10px] text-deployguard-500">
            <span>24h ago</span>
            <span>12h ago</span>
            <span>Now</span>
          </div>
        </div>
      </div>

      {/* Additional Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Requests/min" value={data.requestsPerMinute} unit="Incoming Requests" icon={Wifi} color="text-accent-cyan" />
        <MetricCard label="Active Connections" value={data.activeConnections} unit="Concurrent" icon={Server} color="text-accent-blue" />
        <MetricCard label="Network In" value={`${data.networkIn} MB`} unit="Inbound Traffic" icon={ArrowDownRight} color="text-accent-cyan" />
        <MetricCard label="Network Out" value={`${data.networkOut} MB`} unit="Outbound Traffic" icon={ArrowUpRight} color="text-accent-orange" />
      </div>

      {/* Live Logs (SSE Stream) */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="font-semibold">Live Container Logs</h2>
            <p className="text-xs text-deployguard-400 mt-0.5">
              Server-Sent Events (SSE) streaming from ECS CloudWatch
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-accent-cyan">
              <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse-dot" />
              Streaming
            </span>
          </div>
        </div>
        <div className="bg-deployguard-950 p-4 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
          {[
            { time: "14:30:02", level: "INFO", msg: "Server started on port 3000", source: "nextjs" },
            { time: "14:30:02", level: "INFO", msg: "Health check endpoint /health registered", source: "nextjs" },
            { time: "14:30:05", level: "INFO", msg: "Connected to database successfully", source: "app" },
            { time: "14:30:12", level: "INFO", msg: "GET /api/products 200 42ms", source: "app" },
            { time: "14:30:15", level: "INFO", msg: "GET /api/cart 200 18ms", source: "app" },
            { time: "14:30:18", level: "WARN", msg: "Rate limit approaching for IP 192.168.1.45", source: "middleware" },
            { time: "14:30:22", level: "INFO", msg: "POST /api/checkout 200 156ms", source: "app" },
            { time: "14:30:25", level: "INFO", msg: "GET /api/products 200 38ms", source: "app" },
            { time: "14:30:30", level: "INFO", msg: "ALB health check passed - 200 OK", source: "health" },
            { time: "14:30:33", level: "ERROR", msg: "Payment gateway timeout - retrying in 5s", source: "payment" },
            { time: "14:30:38", level: "INFO", msg: "Payment gateway retry successful", source: "payment" },
            { time: "14:30:45", level: "INFO", msg: "GET /api/orders 200 52ms", source: "app" },
            { time: "14:31:00", level: "INFO", msg: "ALB health check passed - 200 OK", source: "health" },
          ].map((log, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="text-deployguard-500 flex-shrink-0">{log.time}</span>
              <span
                className={`flex-shrink-0 w-12 text-right ${
                  log.level === "ERROR"
                    ? "text-accent-red"
                    : log.level === "WARN"
                    ? "text-accent-orange"
                    : "text-accent-cyan"
                }`}
              >
                {log.level}
              </span>
              <span className="text-deployguard-500 flex-shrink-0">[{log.source}]</span>
              <span className={`${log.level === "ERROR" ? "text-accent-red" : log.level === "WARN" ? "text-accent-orange" : "text-deployguard-300"}`}>
                {log.msg}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Pipeline Metrics */}
      <div className="bg-deployguard-900 border border-border rounded-xl">
        <div className="p-5 border-b border-border">
          <h2 className="font-semibold">Pipeline Performance</h2>
          <p className="text-xs text-deployguard-400 mt-0.5">GitHub Actions build times & Trivy scan durations</p>
        </div>
        <div className="p-5">
          <div className="space-y-4">
            {[
              { stage: "Shallow Clone", duration: 5, maxDuration: 200, color: "bg-accent-cyan" },
              { stage: "Docker Build", duration: 120, maxDuration: 200, color: "bg-accent-blue" },
              { stage: "Trivy Scan", duration: 30, maxDuration: 200, color: "bg-accent-purple" },
              { stage: "Terraform Apply", duration: 180, maxDuration: 200, color: "bg-accent-orange" },
              { stage: "ECS Deploy", duration: 90, maxDuration: 200, color: "bg-accent-cyan" },
              { stage: "Health Check", duration: 60, maxDuration: 200, color: "bg-accent-yellow" },
            ].map((stage) => (
              <div key={stage.stage} className="flex items-center gap-4">
                <span className="text-sm text-deployguard-300 w-32 flex-shrink-0">{stage.stage}</span>
                <div className="flex-1 h-6 bg-deployguard-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${stage.color} rounded-full flex items-center justify-end pr-2`}
                    style={{ width: `${(stage.duration / stage.maxDuration) * 100}%` }}
                  >
                    <span className="text-[10px] font-bold text-deployguard-950">{stage.duration}s</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
