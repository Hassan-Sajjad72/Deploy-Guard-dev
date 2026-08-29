import { Link } from "react-router-dom";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import AppIcon from "../components/common/AppIcon.jsx";
import BrandLogo from "../components/common/BrandLogo.jsx";
import PublicAdminLink from "../components/layout/PublicAdminLink.jsx";
import PublicFooter from "../components/layout/PublicFooter.jsx";
import DeployGuardArchitecture from "../components/marketing/DeployGuardArchitecture.jsx";

export default function Landing() {
  const { isAuthenticated, isLoading, logout, user } = useAuth();

  if (isLoading) {
    return <div className="landing-loading"><LoadingState message="Checking your DeployGuard session..." /></div>;
  }

  const initial = (user?.name || user?.email || "Account").trim().charAt(0).toUpperCase();

  return (
    <div className="landing-page landing-page-simple">
      <div aria-hidden="true" className="landing-ambient"><span /><span /><span /></div>
      <header className="landing-nav glass-nav">
        <Link aria-label="DeployGuard home" className="brand landing-brand" to="/">
          <BrandLogo />
        </Link>
        {isAuthenticated ? (
          <nav aria-label="Account controls" className="landing-nav-actions">
            <Link className="landing-about-link" to="/about">About us</Link>
            <details className="landing-account-menu">
              <summary aria-label="Open account menu" title="Open account menu"><span aria-hidden="true">{initial}</span></summary>
              <div className="landing-account-popover glass-popover">
                <Link to="/dashboard">Dashboard</Link>
                <Link to="/projects">Projects</Link>
                <button onClick={() => void logout()} type="button">Sign out</button>
              </div>
            </details>
          </nav>
        ) : (
          <nav aria-label="Public navigation" className="landing-nav-actions">
            <Link className="landing-about-link" to="/about">About us</Link>
            <PublicAdminLink />
          </nav>
        )}
      </header>
      <main className="landing-home-main">
        <section className="landing-simple-main"><div className="landing-simple-hero">
          <p className="eyebrow">DeployGuard</p>
          <h1>The future doesn’t wait for infrastructure. Neither do we.</h1>
          <p className="landing-lead">Connect your repo. DeployGuard takes it from code to secure, running cloud infrastructure.</p>
          {isAuthenticated ? (
            <Link className="button landing-primary-cta" data-home-deploy="authenticated" to="/deploy">Deploy <AppIcon name="arrow" size={18} /></Link>
          ) : (
            <Link className="button landing-primary-cta" data-home-deploy="oauth" state={{ from: { pathname: "/deploy" } }} to="/auth/github"><AppIcon name="github" size={18} />Continue with GitHub</Link>
          )}
        </div></section>
        <DeployGuardArchitecture />
      </main>
      <PublicFooter />
    </div>
  );
}
