import { Link } from "react-router-dom";
import BrandLogo from "../common/BrandLogo.jsx";

export default function PublicFooter() {
  return <footer className="public-footer">
    <div className="public-footer-inner">
      <Link aria-label="DeployGuard home" to="/"><BrandLogo /></Link>
      <nav aria-label="Footer navigation">
        <Link to="/about">About us</Link>
        <Link to="/admin/login">Admin access</Link>
      </nav>
      <span>DeployGuard © 2026</span>
    </div>
  </footer>;
}
