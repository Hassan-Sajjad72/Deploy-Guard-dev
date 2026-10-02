import { Link } from "react-router-dom";
import AppIcon from "../components/common/AppIcon.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import PublicFooter from "../components/layout/PublicFooter.jsx";
import PublicHeader from "../components/layout/PublicHeader.jsx";
import DeployGuardArchitecture from "../components/marketing/DeployGuardArchitecture.jsx";
import { useAuth } from "../hooks/useAuth.js";

const steps = [
  { title: "Connect a repository", text: "Sign in with GitHub and pick a repository and branch. Monorepos can deploy several services at once." },
  { title: "Add what your app needs", text: "Paste environment variables, and attach a managed database if you want one. Ports and builds are detected." },
  { title: "Deploy", text: "DeployGuard builds an immutable image, scans it, starts it on AWS and checks it is healthy before calling it live." },
  { title: "Operate it", text: "See exactly which release is serving, follow logs and metrics, roll back to the previous release, or destroy it cleanly." },
];

const guarantees = [
  { icon: "commit", title: "You always know what is running", text: "Every release is tied to an exact commit and image. “Latest” is never treated as an answer." },
  { icon: "wrench", title: "Failures explained in plain terms", text: "When something breaks you see what failed, whether it is your code or the platform, and the next safe step." },
  { icon: "rollback", title: "Undo without rebuilding", text: "Rollback restores the previous verified release exactly as it ran — same image, same configuration." },
  { icon: "check-circle", title: "Nothing is called healthy without proof", text: "A release goes live only after its health check passes. Unknown states are shown as unknown." },
];

function ExampleProject() {
  return <figure aria-label="Example of a project overview in DeployGuard" className="hero-example">
    <div className="hero-window">
      <div className="hero-window-bar"><span /><span /><span /><em>rentmate · Overview</em></div>
      <div className="hero-window-body">
        <div className="hero-status"><span className="status tone-ok status-lg">Live</span><p>Serving release 14 from commit <span className="mono">a41f9c2</span>, verified 2 hours ago.</p><span className="hero-url"><AppIcon name="globe" size={15} />rentmate.example.app</span></div>
        <div className="hero-attempt">
          <div className="hero-attempt-head"><span className="status tone-bad">Health check failed</span><span className="muted">attempt 15 · just now</span></div>
          <p>The new release did not pass its health check. <strong>Your previous release is still serving traffic.</strong></p>
          <p className="hero-owner"><AppIcon name="info" size={14} />The problem is in your repository: <span className="mono">STRIPE_WEBHOOK_SECRET</span> is not set.</p>
        </div>
      </div>
    </div>
    <figcaption>Example project, for illustration.</figcaption>
  </figure>;
}

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <LoadingState message="Checking your session…" />;
  const cta = isAuthenticated
    ? <Link className="btn btn-primary btn-lg" data-home-deploy="authenticated" to="/deploy">Deploy a repository<AppIcon name="arrow-right" size={16} /></Link>
    : <Link className="btn btn-primary btn-lg" data-home-deploy="oauth" state={{ from: { pathname: "/deploy" } }} to="/auth/github"><AppIcon name="github" size={18} />Continue with GitHub</Link>;

  return <div className="public landing">
    <PublicHeader />
    <main id="main-content">
      <section aria-labelledby="landing-title" className="hero">
        <div className="hero-copy">
          <h1 id="landing-title">The future doesn’t wait for infrastructure. Neither do we.</h1>
          <p className="hero-lead">Connect a GitHub repository and DeployGuard runs it on AWS — and tells you, at any moment, exactly what is live and what to do when something breaks. No cloud expertise needed.</p>
          <div className="actions">{cta}<a className="btn btn-lg btn-ghost" href="#how-it-works">How it works</a></div>
        </div>
        <ExampleProject />
      </section>

      <section aria-labelledby="how-title" className="public-section" id="how-it-works">
        <div className="public-section-head"><h2 id="how-title">From repository to a live URL</h2><p>Four steps, and you only do the first two.</p></div>
        <ol className="how-steps">{steps.map((step, index) => <li key={step.title}><span aria-hidden="true" className="how-index">{index + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
      </section>

      <section aria-labelledby="guarantee-title" className="public-section">
        <div className="public-section-head"><h2 id="guarantee-title">Built to remove guesswork</h2></div>
        <ul className="guarantees">{guarantees.map((item) => <li key={item.title}><AppIcon name={item.icon} size={20} /><div><h3>{item.title}</h3><p>{item.text}</p></div></li>)}</ul>
      </section>

      <section aria-labelledby="architecture-title" className="public-section" id="delivery-path">
        <div className="public-section-head"><h2 id="architecture-title">Under the hood</h2><p>For the technically curious: what DeployGuard sets up on AWS for you. You never have to manage any of it.</p></div>
        <div className="architecture-frame"><DeployGuardArchitecture /></div>
      </section>

      <section aria-labelledby="closing-title" className="public-closing">
        <h2 id="closing-title">Ship your repository today.</h2>
        <div className="actions">{cta}</div>
      </section>
    </main>
    <PublicFooter />
  </div>;
}
