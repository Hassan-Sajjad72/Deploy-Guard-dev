import AppIcon from "../common/AppIcon.jsx";

// Conceptual marketing illustration of the DeployGuard delivery architecture.
// It is not the live topology of any specific project.

const glyphs = {
  github: "github",
  shield: "shield",
  actions: "pipeline",
  ecr: "box",
  ecs: "infrastructure",
  alb: "branch",
  dns: "activity",
  logs: "logs",
  state: "state",
  storage: "storage",
  cost: "cost",
  user: "user",
};

function Node({ x, y, w = 150, h = 50, icon, label, detail, tone = "default", aws = false, dashed = false, healthy = false }) {
  const left = x - w / 2;
  const top = y - h / 2;
  return <g className={`dg-arch-node is-${tone}${dashed ? " is-dashed" : ""}`}>
    <rect className="dg-arch-node-box" height={h} rx="10" width={w} x={left} y={top} />
    {aws ? <rect className="dg-arch-node-aws" height="3" rx="1.5" width="26" x={left + 12} y={top} /> : null}
    <g transform={`translate(${left + 12} ${y - 9})`}><AppIcon className="dg-arch-glyph" name={glyphs[icon]} size={18} /></g>
    <text className="dg-arch-label" x={left + 38} y={detail ? y - 2 : y + 5}>{label}</text>
    {detail ? <text className="dg-arch-detail" x={left + 38} y={y + 13}>{detail}</text> : null}
    {healthy ? <circle className="dg-arch-health" cx={left + w - 12} cy={top + 12} r="3.5" /> : null}
  </g>;
}

// Major boundaries (cloud, VPC, operations) carry their label as a tag on the top edge;
// availability zones keep an inline label.
function Boundary({ x, y, w, h, label, tone }) {
  const tagged = tone !== "az";
  return <g className={`dg-arch-boundary is-${tone}`}>
    <rect className="dg-arch-boundary-area" height={h} rx="16" width={w} x={x} y={y} />
    {tagged ? <rect className="dg-arch-boundary-tag" height="20" rx="5" width={label.length * 7.2 + 24} x={x + 16} y={y - 10} /> : null}
    <text x={tagged ? x + 26 : x + 16} y={tagged ? y + 4 : y + 22}>{label}</text>
  </g>;
}

function Step({ n, x, y }) {
  return <g className="dg-arch-step"><circle cx={x} cy={y} r="11" /><text x={x} y={y + 4}>{n}</text></g>;
}

export default function DeployGuardArchitecture() {
  return <div className="dg-arch" id="architecture">
    <svg aria-labelledby="dg-arch-title dg-arch-desc" className="dg-arch-diagram" role="img" viewBox="0 0 880 740">
      <title id="dg-arch-title">DeployGuard cloud architecture</title>
      <desc id="dg-arch-desc">A GitHub repository flows through DeployGuard and GitHub Actions, which builds the application image and publishes it to Amazon ECR. Terraform provisions the runtime. Users reach an Application Load Balancer in public subnets, which routes to ECS Fargate tasks in private subnets across two availability zones inside a VPC. CloudWatch, Terraform state and Infracost cost visibility support the runtime.</desc>
      <defs>
        <marker id="dg-arch-arrow" markerHeight="7" markerWidth="7" orient="auto-start-reverse" refX="5" refY="3.5"><path d="M0 0 7 3.5 0 7Z" /></marker>
      </defs>

      <Boundary h={590} label="AWS Cloud · us-east-1" tone="cloud" w={840} x={20} y={140} />
      <Boundary h={452} label="VPC · 10.0.0.0/16" tone="vpc" w={622} x={40} y={268} />
      <Boundary h={392} label="Availability Zone A" tone="az" w={292} x={54} y={310} />
      <Boundary h={392} label="Availability Zone B" tone="az" w={292} x={356} y={310} />
      <Boundary h={452} label="Operations" tone="ops" w={180} x={670} y={268} />

      <g className="dg-arch-subnets">
        <rect className="is-public" height="84" rx="10" width="268" x={66} y={338} /><text x={78} y={355}>Public subnet</text>
        <rect className="is-public" height="84" rx="10" width="268" x={368} y={338} /><text x={380} y={355}>Public subnet</text>
        <rect className="is-private" height="120" rx="10" width="268" x={66} y={432} /><text x={78} y={449}>Private subnet · app</text>
        <rect className="is-private" height="120" rx="10" width="268" x={368} y={432} /><text x={380} y={449}>Private subnet · app</text>
        <rect className="is-data" height="120" rx="10" width="268" x={66} y={562} /><text x={78} y={579}>Private subnet · data</text>
        <rect className="is-data" height="120" rx="10" width="268" x={368} y={562} /><text x={380} y={579}>Private subnet · data</text>
      </g>

      <g className="dg-arch-links">
        <path className="is-control" d="M155 70H174" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-control" d="M350 70H363" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-control" d="M440 95V156H200V178" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-control" d="M304 119H330V262" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-support" d="M125 228V292H60V502H116" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-runtime" d="M760 95V250H350V360" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-runtime" d="M260 410V476" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-runtime" d="M440 410V476" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-support" d="M200 528V606" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-support" d="M500 528V606" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-support" d="M586 502H684" markerEnd="url(#dg-arch-arrow)" />
      </g>

      <Node detail="Selected commit" icon="github" label="GitHub" tone="source" x={90} y={70} w={130} />
      <Node detail="Policy · orchestration" h={60} icon="shield" label="DeployGuard" tone="brand" x={262} y={70} w={176} />
      <Node detail="Application build" icon="actions" label="GitHub Actions" tone="source" x={440} y={70} w={150} />
      <g className="dg-arch-pill"><rect height="22" rx="11" width="84" x={220} y={108} /><text x={262} y={123}>Terraform</text></g>
      <Node detail="Public internet" icon="user" label="Users" tone="edge" x={760} y={70} w={140} h={46} />

      <Node aws detail="Immutable digest" icon="ecr" label="Amazon ECR" x={200} y={203} w={170} />

      <Node aws detail="Internet-facing · targets healthy" healthy icon="alb" label="Application Load Balancer" x={350} y={384} w={360} h={48} />
      <Node aws detail="ECS service · task" healthy icon="ecs" label="Fargate" x={200} y={502} w={168} />
      <Node aws detail="ECS service · task" healthy icon="ecs" label="Fargate" x={500} y={502} w={168} />
      <Node dashed detail="When configured" icon="state" label="Managed database" x={200} y={632} w={180} />
      <Node aws detail="Persistent storage" icon="storage" label="EFS volume" x={500} y={632} w={168} />

      <Node aws detail="S3 state · lock" icon="state" label="Terraform state" x={760} y={372} w={152} />
      <Node aws detail="Logs · metrics" icon="logs" label="CloudWatch" x={760} y={502} w={152} />
      <Node detail="Infracost estimate" icon="cost" label="Cost visibility" tone="cost" x={760} y={632} w={152} />

      <Step n="1" x={169} y={52} />
      <Step n="2" x={440} y={30} />
      <Step n="3" x={400} y={156} />
      <Step n="4" x={330} y={214} />
      <Step n="5" x={560} y={250} />
    </svg>

    <ol aria-label="DeployGuard architecture summary" className="dg-arch-compact">
      <li><span>Control path</span><strong>GitHub → DeployGuard → GitHub Actions → Amazon ECR</strong></li>
      <li><span>Runtime path</span><strong>Users → Application Load Balancer → ECS Fargate in private subnets</strong></li>
      <li><span>Inside the VPC</span><strong>Public subnets · private app subnets · optional managed database</strong></li>
      <li><span>Supporting</span><strong>CloudWatch · Terraform state · Infracost cost visibility</strong></li>
    </ol>
  </div>;
}
