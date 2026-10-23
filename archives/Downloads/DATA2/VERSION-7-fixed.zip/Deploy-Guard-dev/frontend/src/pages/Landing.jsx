import { Link, Navigate } from "react-router-dom";
import { redirectToGithub } from "../api/authApi.js";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

const features = [
  ["Stack Detection", "Identify language, framework, commands, ports, and application structure automatically."],
  ["Docker Templates", "Generate a deployment-ready Dockerfile when the repository does not provide one."],
  ["Security Scan", "Build internally and enforce Trivy vulnerability policy before an image is released."],
  ["FinOps Estimate", "Estimate AWS cost during the automated release and surface policy failures with a clear recovery path."],
  ["AWS ECS Deployment", "Plan infrastructure and deploy through ECS and ALB automatically when the environment enables Apply."],
  ["Observability", "Inspect runtime health, CloudWatch logs, metrics, events, and stable rollback history."],
];

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <div className="landing-loading"><LoadingState message="Checking your DeployGuard session..." /></div>;
  if (isAuthenticated) return <Navigate replace to="/dashboard" />;

  return (
    <div className="landing-page">
      <div aria-hidden="true" className="landing-ambient"><span /><span /><span /></div>
      <header className="landing-nav"><Link className="brand landing-brand" to="/"><span className="brand-mark"><span /></span><span>DeployGuard<small>Deployment platform</small></span></Link><nav><Link className="ghost-nav-link" to="/login">Log in</Link><Link className="secondary-button" to="/signup">Sign up</Link></nav></header>
      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy"><p className="eyebrow">Repository-to-cloud automation</p><h1>Ship the repository. DeployGuard handles the path to production.</h1><p className="landing-lead">Connect a repo once. Watch stack detection, builds, security, infrastructure, and deployment progress in one continuous run—with clear recovery if anything fails.</p><div className="quick-actions"><button className="button landing-primary-cta" onClick={redirectToGithub} type="button"><AppIcon name="github" size={18} />Continue with GitHub</button><Link className="secondary-button" to="/signup">Sign up with email</Link></div><div className="landing-proof"><span>One automated flow</span><span>Live stage visibility</span><span>Retry from failure</span></div></div>
          <aside className="landing-flow"><div className="landing-flow-header"><div><p className="eyebrow">Live automation</p><strong>api-service / main</strong></div><span className="status-pill status-running">Running</span></div><ol><li className="flow-complete">Repository connected</li><li className="flow-complete">Stack detected</li><li className="flow-complete">Image built</li><li className="flow-active">Security scanning</li><li>Infrastructure plan</li><li>Deploy and observe</li></ol><div className="landing-log-sample"><span>12:42:08</span><code>Trivy image scan in progress…</code></div><p>GitHub Actions, Dockerfiles, Terraform, and AWS credentials are not required in application repositories.</p></aside>
        </section>
        <section className="landing-features"><div className="landing-section-heading"><p className="eyebrow">One integrated product</p><h2>The deployment machinery lives in DeployGuard</h2><p>Every page has one job: understand the current run, inspect its details, or recover it.</p></div><div className="landing-feature-grid">{features.map(([title, description]) => <article key={title}><span className="feature-index">0{features.findIndex(([name]) => name === title) + 1}</span><h3>{title}</h3><p>{description}</p></article>)}</div></section>
      </main>
      <footer className="landing-footer">Built for SMEs, students, and teams that need repeatable cloud deployments.</footer>
    </div>
  );
}
