import { Link } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

const pipeline = [
  ["Analyze", "passed"],
  ["Prepare", "passed"],
  ["Build", "running"],
  ["Deploy", "waiting"],
  ["Verify", "waiting"],
];

export default function Landing() {
  const { isAuthenticated, isLoading, logout, user } = useAuth();

  if (isLoading) {
    return <div className="landing-loading"><LoadingState message="Checking your DeployGuard session..." /></div>;
  }

  const initial = (user?.name || user?.email || "Account").trim().charAt(0).toUpperCase();

  return (
    <div className="landing-page landing-page-simple">
      <div aria-hidden="true" className="landing-ambient"><span /><span /><span /></div>
      <header className="landing-nav">
        <Link aria-label="DeployGuard home" className="brand landing-brand" to="/">
          <span className="brand-mark"><span /></span>
          <span>DeployGuard<small>Deployment platform</small></span>
        </Link>
        <div className="landing-nav-center" aria-hidden="true"><span>GitHub</span><span>→</span><span>DeployGuard</span><span>→</span><span>AWS</span></div>
        {isAuthenticated ? (
          <nav aria-label="Account controls" className="landing-nav-actions">
            <Link className="landing-nav-projects" to="/projects">Projects</Link>
            <details className="landing-account-menu">
              <summary aria-label="Open account menu" title="Open account menu"><span aria-hidden="true">{initial}</span></summary>
              <div className="landing-account-popover">
                <Link to="/projects">Projects</Link>
                <button onClick={() => void logout()} type="button">Sign out</button>
              </div>
            </details>
          </nav>
        ) : (
          <nav aria-label="Admin access" className="landing-nav-actions">
            <Link className="landing-admin-link" to="/admin/login">Admin login</Link>
          </nav>
        )}
      </header>

      <main className="landing-simple-main">
        <section className="landing-simple-hero">
          <div className="landing-hero-copy">
            <div className="landing-kicker"><span className="landing-kicker-dot" />From repository to running cloud service</div>
            <h1>We handle the cloud work. Your team ships faster.</h1>
            <p className="landing-lead">Connect a repository once. DeployGuard detects the stack, prepares infrastructure, runs delivery and keeps the live state understandable from one workspace.</p>
            <div className="landing-hero-actions">
              {isAuthenticated ? (
                <Link className="button landing-primary-cta" data-home-deploy="authenticated" to="/deploy">Deploy project <AppIcon name="arrow" size={18} /></Link>
              ) : (
                <Link className="button landing-primary-cta" data-home-deploy="oauth" state={{ from: { pathname: "/deploy" } }} to="/auth/github"><AppIcon name="github" size={18} />Continue with GitHub</Link>
              )}
              <span className="landing-cta-note">No cloud console hopping.<br />No infrastructure guesswork.</span>
            </div>
            <div className="landing-proof-strip" aria-label="DeployGuard capabilities">
              <span><AppIcon name="pipeline" size={15} />GitHub Actions</span>
              <span><AppIcon name="infrastructure" size={15} />Terraform + ECS</span>
              <span><AppIcon name="activity" size={15} />Live telemetry</span>
              <span><AppIcon name="shield" size={15} />Guarded releases</span>
            </div>
          </div>

          <div className="landing-product-stage" aria-label="DeployGuard deployment workspace preview">
            <div className="landing-product-orbit orbit-one" /><div className="landing-product-orbit orbit-two" />
            <section className="landing-product-window">
              <header className="landing-window-bar">
                <div className="landing-window-dots"><i /><i /><i /></div>
                <div className="landing-window-title"><span className="landing-window-brand">DG</span><span>smart-retail-web</span></div>
                <span className="landing-window-live"><i />LIVE</span>
              </header>
              <div className="landing-window-body">
                <div className="landing-window-heading">
                  <div><span className="landing-window-eyebrow">Production deployment</span><strong>Shipping commit 5d191ad</strong></div>
                  <span className="landing-window-percent">68%</span>
                </div>
                <div className="landing-window-progress"><span /></div>
                <ol className="landing-window-pipeline">
                  {pipeline.map(([label, state]) => <li className={`preview-${state}`} key={label}><span>{state === "passed" ? <AppIcon name="check" size={12} /> : null}</span><strong>{label}</strong><small>{state === "running" ? "Building image" : state === "passed" ? "Complete" : "Waiting"}</small></li>)}
                </ol>
                <div className="landing-window-metrics">
                  <article><span>CPU</span><strong>0.10%</strong><small>healthy</small></article>
                  <article><span>Memory</span><strong>3.47%</strong><small>stable</small></article>
                  <article><span>Latency</span><strong>4.9ms</strong><small>ALB response</small></article>
                </div>
                <div className="landing-window-terminal"><span>$</span><code>release candidate healthy — promotion ready</code><i /></div>
              </div>
            </section>
            <div className="landing-floating-card landing-floating-cost"><span>Estimated</span><strong>$54.86</strong><small>/ month</small></div>
            <div className="landing-floating-card landing-floating-health"><span className="landing-health-dot" /><div><strong>1 / 1 healthy</strong><small>Target group</small></div></div>
          </div>
        </section>

        <section className="landing-value-section">
          <div className="landing-value-heading"><p className="eyebrow">One operating surface</p><h2>Cloud delivery without turning every developer into a cloud operator.</h2></div>
          <div className="landing-value-grid">
            <article><span>01</span><h3>Connect</h3><p>Choose the GitHub repository and branch. DeployGuard establishes the deployment contract.</p></article>
            <article><span>02</span><h3>Guard</h3><p>Readiness, immutable releases, cost evidence and health gates stay in one controlled lifecycle.</p></article>
            <article><span>03</span><h3>Operate</h3><p>Infrastructure, deployment evidence, runtime telemetry and troubleshooting remain attached to the project.</p></article>
          </div>
        </section>
      </main>
      <footer className="landing-footer"><span>DeployGuard</span><span>GitHub App access · one Deploy action · authoritative live state</span><span>Built for focused delivery</span></footer>
    </div>
  );
}
