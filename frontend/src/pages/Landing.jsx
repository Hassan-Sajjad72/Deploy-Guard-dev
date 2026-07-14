import { Link } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

const features = [
  ["Automatic setup", "DeployGuard detects the application and prepares a deployment without repository boilerplate."],
  ["Safe container build", "A deployment-ready container configuration is generated and checked before every build."],
  ["Cost-aware deployment", "Cloud cost is estimated before resources are created, with one clear approval when needed."],
  ["Deployment visibility", "Follow a simple release path from repository preparation to a healthy live application."],
];

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <div className="landing-loading"><LoadingState message="Checking your DeployGuard session..." /></div>;
  return (
    <div className="landing-page">
      <div aria-hidden="true" className="landing-ambient"><span /><span /><span /></div>
      <header className="landing-nav"><Link className="brand landing-brand" to="/"><span className="brand-mark"><span /></span><span>DeployGuard<small>Deployment platform</small></span></Link><nav>{isAuthenticated ? <Link className="button" to="/dashboard">Go to Dashboard</Link> : <Link className="button" to="/auth/github"><AppIcon name="github" size={17} />Continue with GitHub</Link>}</nav></header>
      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy"><p className="eyebrow">Repository-to-cloud automation</p><h1>Deploy a GitHub repository without building a delivery platform first.</h1><p className="landing-lead">Choose a repository. DeployGuard detects the app, prepares the container, estimates cost, and guides it to a healthy deployment.</p><div className="quick-actions">{isAuthenticated ? <Link className="button landing-primary-cta" to="/dashboard">Go to Dashboard <AppIcon name="arrow" size={18} /></Link> : <Link className="button landing-primary-cta" to="/auth/github"><AppIcon name="github" size={18} />Continue with GitHub</Link>}</div><div className="landing-proof"><span>GitHub identity</span><span>Automatic setup</span><span>Clear deployment progress</span></div></div>
          <aside className="landing-flow"><div className="landing-flow-header"><div><p className="eyebrow">One deployment flow</p><strong>Repository to running app</strong></div></div><ol><li>Select repository</li><li>Review detected app</li><li>Deploy</li><li>Follow progress</li><li>Open the live app</li></ol><p>No GitHub Actions workflow, Dockerfile, or Terraform files are required in the application repository.</p></aside>
        </section>
        <section className="landing-features"><div className="landing-section-heading"><p className="eyebrow">One integrated product</p><h2>The deployment machinery lives in DeployGuard</h2><p>Every page has one job: understand the current run, inspect its details, or recover it.</p></div><div className="landing-feature-grid">{features.map(([title, description]) => <article key={title}><span className="feature-index">0{features.findIndex(([name]) => name === title) + 1}</span><h3>{title}</h3><p>{description}</p></article>)}</div></section>
      </main>
      <footer className="landing-footer">Built for SMEs, students, and teams that need repeatable cloud deployments.</footer>
    </div>
  );
}
