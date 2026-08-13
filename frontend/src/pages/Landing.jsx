import { Link } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";

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
        {isAuthenticated ? (
          <nav aria-label="Account controls" className="landing-nav-actions">
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
          <p className="eyebrow">DeployGuard</p>
          <h1>We handle the cloud work. Your team ships faster.</h1>
          <p className="landing-lead">Connect GitHub, choose a branch, and DeployGuard builds, deploys and manages the infrastructure for you.</p>
          {isAuthenticated ? (
            <Link className="button landing-primary-cta" data-home-deploy="authenticated" to="/deploy">Deploy <AppIcon name="arrow" size={18} /></Link>
          ) : (
            <Link className="button landing-primary-cta" data-home-deploy="oauth" state={{ from: { pathname: "/deploy" } }} to="/auth/github"><AppIcon name="github" size={18} />Continue with GitHub</Link>
          )}
        </section>
      </main>
      <footer className="landing-footer">GitHub App access · one Deploy click · live status synchronization</footer>
    </div>
  );
}
