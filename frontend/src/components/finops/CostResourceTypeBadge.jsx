const LABELS = {
  ecs_fargate_compute: "Compute",
  load_balancer: "Load Balancer",
  database: "Database",
  storage: "Storage",
  data_transfer: "Data Transfer",
  cloudwatch_logs: "Logs",
  nat_gateway: "NAT",
  other: "Other",
};

export default function CostResourceTypeBadge({ type }) {
  return <span className="status-pill status-running">{LABELS[type] || type || "Other"}</span>;
}
