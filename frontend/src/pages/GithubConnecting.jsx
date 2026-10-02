import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getGithubAuthUrl } from "../api/authApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import BrandLogo from "../components/common/BrandLogo.jsx";

const RETURN_KEY = "deployguard_oauth_return_to";

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/deploy";
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
      navigate("/deploy", { replace: true });
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
    return <main className="center-page"><section className="center-card"><BrandLogo /><div><h1>GitHub sign-in did not finish</h1><p>Nothing about your GitHub or DeployGuard account was changed. You can try again.</p></div><ErrorState message={oauthError ? `GitHub returned: ${oauthError}.` : "DeployGuard could not confirm your session after GitHub sent you back."} title="Sign-in failed" /><div className="actions"><Link className="btn btn-primary" state={{ from: { pathname: "/deploy" } }} to="/auth/github">Try again</Link><Link className="btn btn-ghost" to="/">Back to home</Link></div></section></main>;
  }

  if (isComplete) return <main className="center-page"><section className="center-card"><BrandLogo /><LoadingState inline message="Opening your workspace…" /></section></main>;

  return (
    <main className="center-page">
      <section aria-live="polite" className="center-card">
        <BrandLogo />
        <div className="connecting-mark"><span className="inline-spinner" /><AppIcon name="github" size={20} /></div>
        <div><h1>Taking you to GitHub…</h1><p>Approve DeployGuard on GitHub and you will come straight back here.</p></div>
        <p className="field-hint">Signing in does not change your GitHub account, repositories or settings.</p>
        <Link className="link" to="/">Cancel</Link>
      </section>
    </main>
  );
}
