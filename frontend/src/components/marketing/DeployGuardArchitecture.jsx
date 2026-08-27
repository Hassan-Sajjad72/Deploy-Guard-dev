import AppIcon from "../common/AppIcon.jsx";

const stages = [
  { icon: "github", label: "Repository", detail: "GitHub source and commit" },
  { icon: "search", label: "Detect & plan", detail: "Topology V2 · BuildPlan" },
  { icon: "code", label: "Build & publish", detail: "GitHub Actions · Docker · ECR" },
  { icon: "infrastructure", label: "Provision", detail: "Terraform · AWS infrastructure" },
  { icon: "activity", label: "Run & verify", detail: "ECS · ALB · exact health evidence" },
];

export default function DeployGuardArchitecture() {
  return <section aria-labelledby="architecture-title" className="landing-architecture-section" id="architecture">
    <div className="landing-section-intro"><p className="eyebrow">How DeployGuard works</p><h2 id="architecture-title">From repository to running infrastructure.</h2><p>DeployGuard connects repository intelligence, automated delivery, infrastructure provisioning, and runtime verification in one deployment flow.</p></div>
    <div className="architecture-panel">
      <header><div><span>DeployGuard architecture</span><small>Authoritative delivery path</small></div><strong><i aria-hidden="true" />LIVE</strong></header>
      <ol aria-label="DeployGuard deployment architecture" className="architecture-flow">
        {stages.map((stage, index) => <li key={stage.label}>
          <div className="architecture-node glass-surface-secondary"><span className="architecture-node-icon"><AppIcon name={stage.icon} size={20} /></span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div></div>
          {index < stages.length - 1 ? <span aria-hidden="true" className="architecture-connector"><AppIcon name="arrow" size={17} /></span> : null}
        </li>)}
      </ol>
      <div className="architecture-component-band"><span>Detected application plan</span><div><strong>Frontend</strong><strong>Backend</strong><strong className="is-optional">Managed database when required</strong></div></div>
      <div className="architecture-outcome"><span aria-hidden="true"><AppIcon name="check" size={18} /></span><div><strong>Verified live application</strong><small>Immutable image, runtime identity, routing, and health evidence must agree before promotion.</small></div></div>
    </div>
  </section>;
}
