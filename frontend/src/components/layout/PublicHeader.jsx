import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth.js";
import BrandLogo from "../common/BrandLogo.jsx";

export default function PublicHeader() {
  const { isAuthenticated } = useAuth();
  return <header className="public-header">
    <div className="header-bar">
      <Link aria-label="DeployGuard home" className="public-brand" to="/"><BrandLogo /></Link>
      <nav aria-label="Public navigation" className="public-nav">
        <NavLink to="/about">About</NavLink>
        {isAuthenticated ? <Link className="btn btn-primary btn-sm" to="/projects">Open projects</Link> : <NavLink to="/admin/login">Admin</NavLink>}
      </nav>
    </div>
  </header>;
}
