import { useId } from "react";

/** The DeployGuard mark: a shield with a deploy arrow cut through it. Drawn in ink so it follows the theme. */
export function BrandMark({ size = 24 }) {
  const maskId = `dg-mark-${useId().replaceAll(":", "")}`;
  return <svg aria-hidden="true" className="brand-mark" fill="none" height={size} viewBox="0 0 24 24" width={size}>
    <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <path d="M12 1.5 20.75 4.7v6.45c0 5.5-3.45 9.35-8.75 11.35-5.3-2-8.75-5.85-8.75-11.35V4.7L12 1.5Z" fill="#fff" />
      <path d="M12 16.75V7.9M8.25 11.4 12 7.65l3.75 3.75" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25" />
    </mask>
    <rect fill="currentColor" height="24" mask={`url(#${maskId})`} width="24" />
  </svg>;
}

export default function BrandLogo({ context }) {
  return <span className="brand">
    <BrandMark size={24} />
    <span>DeployGuard{context ? <small className="brand-context">{context}</small> : null}</span>
  </span>;
}
