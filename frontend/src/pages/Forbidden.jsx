import { Link } from "react-router-dom";
import BrandLogo from "../components/common/BrandLogo.jsx";

export default function Forbidden() {
  return <main className="center-page">
    <section className="center-card">
      <BrandLogo />
      <div><h1>You don’t have access to this page</h1><p>Your account’s role does not allow this action. Ask a workspace developer or an administrator if you need access.</p></div>
      <div className="actions"><Link className="btn btn-primary" to="/projects">Back to projects</Link></div>
    </section>
  </main>;
}
