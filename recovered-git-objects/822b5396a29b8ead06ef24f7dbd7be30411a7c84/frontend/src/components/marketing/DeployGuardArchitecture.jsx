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
  { icon: "pipeline", label: "Terraform", detail: "Infrastructure state" },
  { icon: "activity", label: "CloudWatch", detail: "Metrics + logs" },
  { icon: "cost", label: "Cost visibility", detail: "Infracost estimate" },
];

export default function DeployGuardArchitecture() {
  return <section aria-labelledby="architecture-title" className="landing-architecture-section" id="architecture">
    <div className="architecture-heading"><span>Live architecture</span><strong id="architecture-title">One immutable delivery path</strong><i><b aria-hidden="true" /> Verified</i></div>
    <div className="architecture-scene" role="img" aria-label="GitHub repository passes through DeployGuard and GitHub Actions to ECR, ECS Fargate, an application load balancer and Route 53 inside a VPC, with CloudWatch monitoring, Terraform infrastructure and Infracost cost visibility.">
      <svg aria-hidden="true" className="architecture-wiring" preserveAspectRatio="none" viewBox="0 0 1000 420">
        <path d="M82 112 H918" />
        <path d="M500 112 V310" />
        <path d="M500 310 H190" />
        <path d="M500 310 H810" />
      </svg>
      <ol aria-label="DeployGuard deployment architecture" className="architecture-flow">
        {delivery.map((stage) => <li key={stage.label}>
          <div className={`architecture-node${stage.accent ? " is-control" : ""}${stage.healthy ? " is-healthy" : ""}`}><span className="architecture-node-icon"><AppIcon name={stage.icon} size={19} /></span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div></div>
        </li>)}
      </ol>
      <aside aria-label="Operational visibility" className="architecture-operations">
        <span className="architecture-operations-label">AWS operating layer</span>
        <div>{operations.map((item) => <article key={item.label}><span><AppIcon name={item.icon} size={17} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div></article>)}</div>
      </aside>
      <div className="architecture-outcome"><span aria-hidden="true"><AppIcon name="check" size={18} /></span><div><strong>Release promoted</strong><small>Only after runtime and route verification</small></div></div>
    </div>
  </section>;
}
