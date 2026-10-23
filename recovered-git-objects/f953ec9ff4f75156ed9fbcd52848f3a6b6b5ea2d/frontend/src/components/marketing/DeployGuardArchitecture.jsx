import AppIcon from "../common/AppIcon.jsx";

const delivery = [
  { icon: "github", label: "GitHub Repository", detail: "Selected commit" },
  { icon: "shield", label: "DeployGuard", detail: "Policy + orchestration", accent: true },
  { icon: "pipeline", label: "GitHub Actions", detail: "Build image" },
  { icon: "box", label: "Amazon ECR", detail: "Publish immutable image" },
  { icon: "infrastructure", label: "ECS / Fargate", detail: "Provision runtime", healthy: true },
  { icon: "activity", label: "Application Load Balancer", detail: "Run & verify", healthy: true },
  { icon: "infrastructure", label: "Route 53", detail: "Public route", healthy: true },
];

const operations = [
  { icon: "infrastructure", label: "VPC", detail: "Isolated network" },
  { icon: "activity", label: "CloudWatch", detail: "Metrics + logs" },
  { icon: "cost", label: "Cost visibility", detail: "Infracost estimate" },
];

export default function DeployGuardArchitecture() {
  return <section aria-labelledby="architecture-title" className="landing-architecture-section" id="architecture">
    <div className="landing-section-intro"><p className="eyebrow">The delivery system</p><h2 id="architecture-title">One verified path from commit to cloud.</h2><p>Every handoff stays visible—from GitHub identity to AWS runtime health and operating cost.</p></div>
    <div className="architecture-panel" role="img" aria-label="GitHub repository passes through DeployGuard and GitHub Actions to ECR, ECS Fargate, an application load balancer and Route 53 inside a VPC, with CloudWatch monitoring and cost visibility.">
      <header><div><span>Release topology</span><small>Immutable delivery path</small></div><strong><i aria-hidden="true" />VERIFIED</strong></header>
      <div className="architecture-canvas">
        <ol aria-label="DeployGuard deployment architecture" className="architecture-flow">
          {delivery.map((stage, index) => <li key={stage.label}>
            <div className={`architecture-node${stage.accent ? " is-control" : ""}${stage.healthy ? " is-healthy" : ""}`}><span className="architecture-node-icon"><AppIcon name={stage.icon} size={19} /></span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div></div>
            {index < delivery.length - 1 ? <span aria-hidden="true" className="architecture-connector"><i /></span> : null}
          </li>)}
        </ol>
        <aside aria-label="Operational visibility" className="architecture-operations">
          <span className="architecture-operations-label">AWS operating layer</span>
          <div>{operations.map((item) => <article key={item.label}><span><AppIcon name={item.icon} size={17} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div></article>)}</div>
        </aside>
      </div>
      <div className="architecture-outcome"><span aria-hidden="true"><AppIcon name="check" size={18} /></span><div><strong>Verified live application</strong><small>Release promotion waits until source SHA, image digest, task identity, routing, and health evidence agree.</small></div></div>
    </div>
  </section>;
}
