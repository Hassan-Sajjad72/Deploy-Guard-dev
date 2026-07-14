import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getGithubAuthUrl } from "../api/authApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";

const RETURN_KEY = "deployguard_oauth_return_to";

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

export default function GithubConnecting() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, refreshUser } = useAuth();
  const refreshAttempted = useRef(false);
  const [callbackFailed, setCallbackFailed] = useState(false);
  const params = new URLSearchParams(location.search);
  const oauthError = params.get("error");
  const isComplete = params.get("complete") === "1";

  useEffect(() => {
    if (oauthError) return undefined;
    if (isComplete) {
      if (isLoading) return undefined;
      if (isAuthenticated) {
        const returnTo = safeReturnTo(window.sessionStorage.getItem(RETURN_KEY));
        window.sessionStorage.removeItem(RETURN_KEY);
        navigate(returnTo, { replace: true });
        return undefined;
      }
      if (refreshAttempted.current) return undefined;
      refreshAttempted.current = true;
      refreshUser().then((user) => {
        if (!user) {
          setCallbackFailed(true);
          return;
        }
        const returnTo = safeReturnTo(window.sessionStorage.getItem(RETURN_KEY));
        window.sessionStorage.removeItem(RETURN_KEY);
        navigate(returnTo, { replace: true });
      });
      return undefined;
    }
    if (isAuthenticated) {
      navigate("/dashboard", { replace: true });
      return undefined;
    }
    const from = location.state?.from;
    if (from) window.sessionStorage.setItem(RETURN_KEY, safeReturnTo(`${from.pathname || ""}${from.search || ""}${from.hash || ""}`));
    const redirectTimer = window.setTimeout(() => {
      window.location.assign(getGithubAuthUrl());
    }, 250);

    return () => window.clearTimeout(redirectTimer);
  }, [isAuthenticated, isComplete, isLoading, location.state, navigate, oauthError, refreshUser]);

  if (oauthError || callbackFailed) {
    return <main className="oauth-connecting-page"><section className="oauth-connecting-card"><ErrorState message="GitHub authentication could not be completed. Your account was not changed." /><Link className="button" to="/login">Return to login</Link><Link className="ghost-nav-link" to="/">Back to home</Link></section></main>;
  }

  if (isComplete) return <main className="oauth-connecting-page"><section className="oauth-connecting-card"><LoadingState message="Opening your DeployGuard workspace…" /></section></main>;

  return (
    <main className="oauth-connecting-page">
      <div aria-hidden="true" className="landing-ambient"><span /><span /><span /></div>
      <section className="oauth-connecting-card" aria-live="polite">
        <span className="oauth-spinner"><AppIcon name="github" size={24} /></span>
        <p className="eyebrow">Secure authentication</p>
        <h1>Connecting to GitHub…</h1>
        <p>You’ll continue on GitHub and return to your deployment dashboard after authentication.</p>
        <Link className="ghost-nav-link" to="/">Cancel and return home</Link>
      </section>
    </main>
  );
}
