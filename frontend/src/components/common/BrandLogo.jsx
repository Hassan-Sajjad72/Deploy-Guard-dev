export default function BrandLogo({ context }) {
  return <span className="brand">
    <img alt="" height="26" src="/deployguard-mark.svg" width="26" />
    <span>DeployGuard{context ? <small className="brand-context">{context}</small> : null}</span>
  </span>;
}
