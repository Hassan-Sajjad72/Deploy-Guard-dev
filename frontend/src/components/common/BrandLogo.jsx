export default function BrandLogo({ compact = false, context = "Deployment platform" }) {
  return <span className={compact ? "brand-identity is-compact" : "brand-identity"}>
    <img alt="" className="brand-identity-mark" height="42" src="/deployguard-mark.svg" width="42" />
    {!compact ? <span className="brand-identity-copy"><strong>DeployGuard</strong><small>{context}</small></span> : null}
  </span>;
}
