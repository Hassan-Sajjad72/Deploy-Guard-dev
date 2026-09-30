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
  cost: "cost",
  user: "user",
};

function Node({ x, y, w = 150, h = 50, icon, label, detail, tone = "default", aws = false }) {
  const left = x - w / 2;
  const top = y - h / 2;
  return <g className={`dg-arch-node is-${tone}`}>
    <rect className="dg-arch-node-box" height={h} rx="10" width={w} x={left} y={top} />
    {aws ? <rect className="dg-arch-node-aws" height="3" rx="1.5" width="26" x={left + 12} y={top} /> : null}
    <g transform={`translate(${left + 12} ${y - 9})`}><AppIcon className="dg-arch-glyph" name={glyphs[icon]} size={18} /></g>
    <text className="dg-arch-label" x={left + 38} y={detail ? y - 2 : y + 5}>{label}</text>
    {detail ? <text className="dg-arch-detail" x={left + 38} y={y + 13}>{detail}</text> : null}
  </g>;
}

// Major cloud, runtime, and supporting boundaries carry a label on the top edge.
function Boundary({ x, y, w, h, label, tone }) {
  const tagged = tone !== "az";
  return <g className={`dg-arch-boundary is-${tone}`}>
    <rect className="dg-arch-boundary-area" height={h} rx="16" width={w} x={x} y={y} />
    {tagged ? <rect className="dg-arch-boundary-tag" height="20" rx="5" width={label.length * 7.5 + 20} x={x + 16} y={y - 10} /> : null}
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
      <desc id="dg-arch-desc">An illustrative deployment flow from source through build, image publication, and a cloud runtime. The example shows a load balancer routing to a container service, with separate supporting capabilities for application telemetry, infrastructure state, and cost visibility. This is not a live project topology.</desc>
      <defs>
        <marker id="dg-arch-arrow" markerHeight="7" markerWidth="7" orient="auto-start-reverse" refX="5" refY="3.5"><path d="M0 0 7 3.5 0 7Z" /></marker>
      </defs>

      <Boundary h={590} label="Cloud environment" tone="cloud" w={840} x={20} y={140} />
      <Boundary h={452} label="Application network" tone="vpc" w={622} x={40} y={268} />
      <Boundary h={452} label="Support services" tone="ops" w={180} x={670} y={268} />

      <g className="dg-arch-links">
        <path className="is-control" d="M155 70H174" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-control" d="M350 70H363" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-control" d="M440 95V156H200V178" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-runtime" d="M760 95V250H350V360" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-runtime" d="M350 408V476" markerEnd="url(#dg-arch-arrow)" />
        <path className="is-support" d="M450 502H684" markerEnd="url(#dg-arch-arrow)" />
      </g>

      <Node detail="Selected commit" icon="github" label="GitHub" tone="source" x={90} y={70} w={130} />
      <Node detail="Policy · orchestration" h={60} icon="shield" label="DeployGuard" tone="brand" x={262} y={70} w={176} />
      <Node detail="Application build" icon="actions" label="Build runner" tone="source" x={440} y={70} w={150} />
      <g className="dg-arch-pill"><rect height="22" rx="11" width="140" x={192} y={108} /><text x={262} y={123}>Infrastructure plan</text></g>
      <Node detail="Public internet" icon="user" label="Users" tone="edge" x={760} y={70} w={140} h={46} />

      <Node aws detail="Versioned image" icon="ecr" label="Image registry" x={200} y={203} w={170} />

      <Node aws detail="Example application route" icon="alb" label="Load balancer" x={350} y={384} w={300} h={48} />
      <Node aws detail="Application workload" icon="ecs" label="Container service" x={350} y={502} w={200} />
      <Node aws detail="State management" icon="state" label="Infrastructure state" x={760} y={372} w={164} />
      <Node aws detail="Logs · telemetry" icon="logs" label="Application signals" x={760} y={502} w={164} />
      <Node detail="Estimated spend" icon="cost" label="Cost visibility" tone="cost" x={760} y={632} w={164} />

      <Step n="1" x={169} y={52} />
      <Step n="2" x={440} y={30} />
      <Step n="3" x={400} y={156} />
      <Step n="4" x={330} y={214} />
      <Step n="5" x={560} y={250} />
    </svg>

    <ol aria-label="DeployGuard architecture summary" className="dg-arch-compact">
      <li><span>Control path</span><strong>Source → DeployGuard → build → image registry</strong></li>
      <li><span>Runtime path</span><strong>Users → load balancer → container service</strong></li>
      <li><span>Network</span><strong>Example public entry and isolated application network</strong></li>
      <li><span>Supporting</span><strong>Application telemetry · infrastructure state · cost visibility</strong></li>
    </ol>
    <p className="dg-arch-note">Illustrative topology · not a live project view</p>
  </div>;
}

const stages = [
  { label: "Source", detail: "Select a repository revision" },
  { label: "Build", detail: "Prepare the application image" },
  { label: "Publish", detail: "Store a versioned image" },
  { label: "Provision", detail: "Create the cloud runtime" },
  { label: "Verify", detail: "Review routing and runtime evidence" },
];

export function DeliveryPath() {
  return <section aria-labelledby="delivery-path-title" className="dg-delivery dg-dark" id="delivery-path">
    <div className="dg-delivery-intro">
      <p className="dg-kicker">How DeployGuard works</p>
      <h2 id="delivery-path-title">From repository to running infrastructure.</h2>
      <p>DeployGuard prepares an application image, creates its runtime, and checks the result before promotion.</p>
      <p className="dg-delivery-note">Illustrative workflow · not a live project pipeline.</p>
    </div>
    <ol className="dg-delivery-steps">
      {stages.map((stage, index) => <li key={stage.label}>
        <span className="dg-delivery-index">{String(index + 1).padStart(2, "0")}</span>
        <strong>{stage.label}</strong>
        <small>{stage.detail}</small>
      </li>)}
    </ol>
    <p className="dg-delivery-outcome"><span aria-hidden="true"><AppIcon name="shield" size={14} /></span><strong>Promotion gate</strong> The deployed release and available runtime evidence must agree before promotion.</p>
  </section>;
}
