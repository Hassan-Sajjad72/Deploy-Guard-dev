import { Link } from "react-router-dom";
import BrandLogo from "../common/BrandLogo.jsx";

export default function PublicFooter() {
  return <footer className="public-footer">
    <div className="public-footer-inner">
      <div className="public-footer-brand">
        <BrandLogo />
        <p>Repository intelligence, deployment automation, and runtime evidence in one platform.</p>
      </div>
      <nav aria-label="Footer navigation" className="public-footer-nav">
        <div><strong>Product</strong><Link to="/">Home</Link><Link to="/projects">Projects</Link></div>
        <div><strong>Company</strong><Link to="/about">About us</Link><Link to="/admin/login">Admin access</Link></div>
      </nav>
    </div>
    <div className="public-footer-meta"><span>DeployGuard © 2026</span><span>Deployment platform</span></div>
  </footer>;
}
